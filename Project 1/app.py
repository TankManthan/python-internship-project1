from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any
from io import BytesIO
from PIL import Image
import numpy as np
import cv2
import base64
import asyncio
import uvicorn
import io

# ------------------------ Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active: set[WebSocket] = set()
        self.lock = asyncio.Lock()
        self.history: list[str] = []
        self.max_history = 500

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self.lock:
            self.active.add(websocket)
            for msg in self.history:
                try:
                    await websocket.send_text(msg)
                except Exception:
                    pass

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            self.active.discard(websocket)

    async def broadcast(self, message: str, save: bool = True):
        if save:
            self.history.append(message)
            if len(self.history) > self.max_history:
                self.history.pop(0)
        async with self.lock:
            to_remove = []
            for ws in list(self.active):
                try:
                    await ws.send_text(message)
                except Exception:
                    to_remove.append(ws)
            for ws in to_remove:
                self.active.discard(ws)

# --------------------- FastAPI App 
app = FastAPI()
manager = ConnectionManager()

# CORS for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True
)

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return HTMLResponse(open("static/index.html", "r", encoding="utf-8").read())

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            await manager.broadcast(data)
    except WebSocketDisconnect:
        await manager.disconnect(websocket)

# ------ Utilities 
def pil_to_cv2(img: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(img.convert('RGB')), cv2.COLOR_RGB2BGR)

def contours_to_svg(contours: List[np.ndarray], img_w: int, img_h: int) -> str:
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {img_w} {img_h}">']
    for cnt in contours:
        pts = cnt.reshape(-1, 2)
        path = "M " + " L ".join(f"{int(x)},{int(y)}" for x, y in pts) + " Z"
        parts.append(f'<path d="{path}" fill="none" stroke="#000" stroke-width="2"/>')
    parts.append('</svg>')
    return "".join(parts)

def interpret_image_bytes(image_bytes: bytes) -> Dict[str, Any]:
    pil = Image.open(io.BytesIO(image_bytes))
    orig_w, orig_h = pil.size

    cv_img = pil_to_cv2(pil)
    gray = cv2.cvtColor(cv_img, cv2.COLOR_BGR2GRAY)
    max_dim = 1200
    scale = 1.0
    if max(orig_w, orig_h) > max_dim:
        scale = max_dim / max(orig_w, orig_h)
        gray = cv2.resize(gray, (int(orig_w * scale), int(orig_h * scale)), interpolation=cv2.INTER_AREA)

    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    th = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                               cv2.THRESH_BINARY_INV, 11, 2)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    closed = cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel, iterations=1)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    nodes, svg_contours = [], []

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < 100: 
            continue
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.01 * peri, True)
        if scale != 1.0:
            approx = (approx / scale).astype(int)
        x, y, w, h = cv2.boundingRect(approx)
        cx, cy = x + w / 2, y + h / 2
        node = {
            'id': f'node_{len(nodes)+1}',
            'bbox': [int(x), int(y), int(w), int(h)],
            'centroid': [float(cx), float(cy)],
            'area': float(area) * (1.0/(scale*scale)),
            'points': approx.reshape(-1, 2).tolist(),
            'type_guess': 'shape'
        }
        nodes.append(node)
        svg_contours.append(approx)

    edges = []
    for i in range(len(nodes)):
        for j in range(i+1, len(nodes)):
            dx = nodes[i]['centroid'][0] - nodes[j]['centroid'][0]
            dy = nodes[i]['centroid'][1] - nodes[j]['centroid'][1]
            dist = (dx*dx + dy*dy) ** 0.5
            if dist < max(orig_w, orig_h) * 0.25:
                edges.append({'from': nodes[i]['id'], 'to': nodes[j]['id'], 'score': float(max(0, 1 - dist / (max(orig_w, orig_h))))})

    svg = contours_to_svg(svg_contours, orig_w, orig_h)

    return {
        'meta': {'width': orig_w, 'height': orig_h, 'num_nodes': len(nodes), 'num_edges': len(edges)},
        'nodes': nodes,
        'edges': edges,
        'svg': svg
    }

# ---------- AI Cleanup Endpoint 
class ImageData(BaseModel):
    image: str  # base64 string

@app.post("/ai-cleanup")
async def ai_cleanup(data: ImageData):
    """
    Receives a base64 image from canvas, returns cleaned SVG + JSON nodes/edges.
    """
    if not data.image:
        raise HTTPException(status_code=400, detail="Missing image data")
    try:
        img_str = data.image.split(",")[1] if "," in data.image else data.image
        img_bytes = base64.b64decode(img_str)
        result = interpret_image_bytes(img_bytes)
        return {"cleanedSVG": result['svg'], "nodes": result['nodes'], "edges": result['edges']}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# -------------- Interpret Endpoints 
@app.post('/interpret')
async def interpret(file: UploadFile = File(...)):
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail='file must be an image')
    body = await file.read()
    return JSONResponse(content=interpret_image_bytes(body))

@app.post('/interpret/base64')
async def interpret_base64(data: Dict[str, str]):
    b64 = data.get('b64')
    if not b64:
        raise HTTPException(status_code=400, detail='missing b64 field')
    if b64.startswith('data:'):
        b64 = b64.split(',', 1)[1]
    body = base64.b64decode(b64)
    return JSONResponse(content=interpret_image_bytes(body))

@app.post('/interpret/svg')
async def interpret_svg(file: UploadFile = File(...)):
    body = await file.read()
    result = interpret_image_bytes(body)
    return PlainTextResponse(content=result['svg'], media_type='image/svg+xml')

# ------------------------ Main ------------------------
if __name__ == '__main__':
    uvicorn.run('app:app', host='0.0.0.0', port=8000, reload=True)
