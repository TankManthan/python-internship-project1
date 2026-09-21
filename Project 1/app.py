import os
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, HTTPException, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
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
import bcrypt


from db import diagrams, users
from bson import ObjectId
from datetime import datetime


# ------------------------ Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active: dict[WebSocket, str] = {}  # websocket -> username
        self.lock = asyncio.Lock()
        self.history: list[str] = []
        self.max_history = 500

    async def connect(self, websocket: WebSocket, username: str):
        await websocket.accept()
        async with self.lock:
            self.active[websocket] = username
            for msg in self.history:
                try:
                    await websocket.send_text(msg)
                except Exception:
                    pass
        await self.broadcast_presence()

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            self.active.pop(websocket, None)
        await self.broadcast_presence()

    async def broadcast(self, message: str, save: bool = True):
        if save:
            self.history.append(message)
            if len(self.history) > self.max_history:
                self.history.pop(0)
        async with self.lock:
            to_remove = []
            for ws in list(self.active.keys()):
                try:
                    await ws.send_text(message)
                except Exception:
                    to_remove.append(ws)
            for ws in to_remove:
                self.active.pop(ws, None)

    async def broadcast_presence(self):
        usernames = sorted(set(self.active.values()))
        payload = json.dumps({"type": "presence", "count": len(self.active), "users": usernames})
        await self.broadcast(payload, save=False)

# --------------------- FastAPI App
app = FastAPI()
manager = ConnectionManager()

# NOTE: set a real, secret value via the SESSION_SECRET env var in production.
# This fallback is fine for local development only.
SESSION_SECRET = os.getenv("SESSION_SECRET", "dev-only-change-me")

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    session_cookie="sketchboard_session",
    max_age=60 * 60 * 24 * 7,  # 7 days
    same_site="lax",
)

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


@app.on_event("startup")
async def on_startup():
    # Prevent two accounts with the same username
    await users.create_index("username", unique=True)


# ------ Auth helpers ------
def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except Exception:
        return False


def require_login(request: Request):
    username = request.session.get("user")
    if not username:
        raise HTTPException(status_code=401, detail="Not logged in")
    return username


class AuthPayload(BaseModel):
    username: str
    password: str


@app.post("/signup")
async def signup(payload: AuthPayload, request: Request):
    username = payload.username.strip().lower()
    if not username or not payload.password:
        raise HTTPException(status_code=400, detail="Username and password are required")
    if len(payload.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    existing = await users.find_one({"username": username})
    if existing:
        raise HTTPException(status_code=409, detail="That username is already taken")

    await users.insert_one({
        "username": username,
        "password_hash": hash_password(payload.password),
        "created_at": datetime.utcnow()
    })
    request.session["user"] = username
    return {"ok": True, "username": username}


@app.post("/login")
async def login(payload: AuthPayload, request: Request):
    username = payload.username.strip().lower()
    user = await users.find_one({"username": username})
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    request.session["user"] = username
    return {"ok": True, "username": username}


@app.post("/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/me")
async def me(request: Request):
    username = request.session.get("user")
    if not username:
        raise HTTPException(status_code=401, detail="Not logged in")
    return {"username": username}


# ------ Pages ------
@app.get("/")
async def root(request: Request):
    if not request.session.get("user"):
        return RedirectResponse(url="/login")
    return HTMLResponse(open("static/index.html", "r", encoding="utf-8").read())


@app.get("/login")
async def login_page(request: Request):
    if request.session.get("user"):
        return RedirectResponse(url="/")
    return HTMLResponse(open("static/login.html", "r", encoding="utf-8").read())


@app.get("/signup")
async def signup_page(request: Request):
    if request.session.get("user"):
        return RedirectResponse(url="/")
    return HTMLResponse(open("static/signup.html", "r", encoding="utf-8").read())


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    username = websocket.session.get("user")
    if not username:
        await websocket.close(code=4401)
        return
    await manager.connect(websocket, username)
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
async def ai_cleanup(data: ImageData, user: str = Depends(require_login)):
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
async def interpret(file: UploadFile = File(...), user: str = Depends(require_login)):
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail='file must be an image')
    body = await file.read()
    return JSONResponse(content=interpret_image_bytes(body))

@app.post('/interpret/base64')
async def interpret_base64(data: Dict[str, str], user: str = Depends(require_login)):
    b64 = data.get('b64')
    if not b64:
        raise HTTPException(status_code=400, detail='missing b64 field')
    if b64.startswith('data:'):
        b64 = b64.split(',', 1)[1]
    body = base64.b64decode(b64)
    return JSONResponse(content=interpret_image_bytes(body))

@app.post('/interpret/svg')
async def interpret_svg(file: UploadFile = File(...), user: str = Depends(require_login)):
    body = await file.read()
    result = interpret_image_bytes(body)
    return PlainTextResponse(content=result['svg'], media_type='image/svg+xml')



def serialize(diagram: dict) -> dict:
    return {
        "id": str(diagram["_id"]),
        "title": diagram.get("title", "Untitled"),
        "svg": diagram.get("svg"),
        "nodes": diagram.get("nodes", []),
        "edges": diagram.get("edges", []),
        "user_id": diagram.get("user_id"),
        "created_at": diagram.get("created_at")
    }

# -------------------------
# Save a diagram
# -------------------------
@app.post("/diagrams/save")
async def save_diagram(payload: Dict[str, Any], user: str = Depends(require_login)):
    payload["created_at"] = datetime.utcnow()
    payload["user_id"] = user
    result = await diagrams.insert_one(payload)
    return {"id": str(result.inserted_id)}


# -------------------------
# List all diagrams (must be BEFORE /{diagram_id})
# -------------------------
@app.get("/diagrams/list")
async def list_diagrams(user: str = Depends(require_login)):
    cursor = diagrams.find({}, {"title": 1, "created_at": 1})
    results = []
    async for doc in cursor:
        results.append({
            "id": str(doc["_id"]),
            "title": doc.get("title", "Untitled"),
            "created_at": doc.get("created_at")
        })
    return results


# -------------------------
# Get one diagram by ID
# -------------------------
@app.get("/diagrams/{diagram_id}")
async def get_diagram(diagram_id: str, user: str = Depends(require_login)):
    try:
        oid = ObjectId(diagram_id)
    except:
        raise HTTPException(status_code=400, detail="Invalid diagram id")

    doc = await diagrams.find_one({"_id": oid})
    if not doc:
        raise HTTPException(status_code=404, detail="Not found")

    doc["id"] = str(doc["_id"])
    return doc


# ------------------------ Main ------------------------
if __name__ == '__main__':
    uvicorn.run('app:app', host='0.0.0.0', port=8000, reload=True)