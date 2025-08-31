// Minimal collaborative drawing client
(function () {
    const canvas = document.getElementById('c');
    const colorPicker = document.getElementById('color');
    const widthRange = document.getElementById('width');
    const clearBtn = document.getElementById('clear');
    const ctx = canvas.getContext('2d');

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    // WebSocket connection to server
    const loc = window.location;
    const wsProtocol = (loc.protocol === 'https:') ? 'wss' : 'ws';
    const wsUrl = `${wsProtocol}://${loc.host}/ws`;
    const ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => console.log('ws open'));
    ws.addEventListener('close', () => console.log('ws closed'));
    ws.addEventListener('error', (e) => console.error('ws error', e));

    // incoming messages
    ws.addEventListener('message', (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'stroke') {
                drawStroke(msg);
            } else if (msg.type === 'shape') {
                drawShape(msg);
            } else if (msg.type === 'clear') {
                clearCanvas(false);
            }
        } catch (e) { console.error('bad message', e) }
    });

    // --- Drawing functions ---
    function drawShape(shape) {
        ctx.strokeStyle = shape.color;
        ctx.lineWidth = shape.width;

        const startX = shape.start.x * canvas.width;
        const startY = shape.start.y * canvas.height;
        const endX = shape.end.x * canvas.width;
        const endY = shape.end.y * canvas.height;
        const w = endX - startX;
        const h = endY - startY;

        if (shape.shapeType === 'rectangle') {
            ctx.strokeRect(startX, startY, w, h);
        } else if (shape.shapeType === 'circle') {
            ctx.beginPath();
            const radius = Math.sqrt(w * w + h * h);
            ctx.arc(startX, startY, radius, 0, 2 * Math.PI);
            ctx.stroke();
        } else if (shape.shapeType === 'line') {
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(endX, endY);
            ctx.stroke();
        } else if (shape.shapeType === 'arrow') {
            drawArrow(ctx, startX, startY, endX, endY);
        }
    }

    function drawStroke(stroke) {
        const points = stroke.points;
        if (!points || points.length === 0) return;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = stroke.color || '#000';
        ctx.lineWidth = stroke.width || 3;
        ctx.beginPath();
        ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
        }
        ctx.stroke();
    }

    function clearCanvas(send = true) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (send && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'clear' }));
        }
    }
    clearBtn.addEventListener('click', () => clearCanvas(true));

    // Tool Handling 
    const buttons = {
        pencil: document.getElementById('pencilBtn'),
        rectangle: document.getElementById('rectBtn'),
        circle: document.getElementById('circleBtn'),
        line: document.getElementById('lineBtn'),
        arrow: document.getElementById('arrowBtn')
    };

    let currentTool = 'pencil';
    let isDrawing = false;
    let startX, startY;
    let savedImageData;
    let pencilPoints = [];

    function clearActive() {
        Object.values(buttons).forEach(btn => btn.classList.remove('active'));
    }

    function selectTool(tool) {
        if (currentTool === tool) {
            currentTool = null;
            clearActive();
        } else {
            currentTool = tool;
            clearActive();
            buttons[tool].classList.add('active');
        }
    }

    buttons.pencil.onclick = () => selectTool('pencil');
    buttons.rectangle.onclick = () => selectTool('rectangle');
    buttons.circle.onclick = () => selectTool('circle');
    buttons.line.onclick = () => selectTool('line');
    buttons.arrow.onclick = () => selectTool('arrow');

    function drawArrow(ctx, x1, y1, x2, y2) {
        const headLength = 4 * ctx.lineWidth;
        const angle = Math.atan2(y2 - y1, x2 - x1);

        // Arrowhead base points
        const arrowX1 = x2 - headLength * Math.cos(angle - Math.PI / 7);
        const arrowY1 = y2 - headLength * Math.sin(angle - Math.PI / 7);
        const arrowX2 = x2 - headLength * Math.cos(angle + Math.PI / 7);
        const arrowY2 = y2 - headLength * Math.sin(angle + Math.PI / 7);

        // Shaft ends before the tip (so arrowhead edges connect cleanly)
        const shaftEndX = x2 - (headLength * 0.6) * Math.cos(angle);
        const shaftEndY = y2 - (headLength * 0.6) * Math.sin(angle);

        // Draw shaft
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(shaftEndX, shaftEndY);
        ctx.stroke();

        // Draw arrowhead outline (not filled)
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(arrowX1, arrowY1);
        ctx.moveTo(x2, y2);
        ctx.lineTo(arrowX2, arrowY2);
        ctx.stroke();
    }



    //  Drawing Events 
    canvas.addEventListener('mousedown', (e) => {
        if (!currentTool) return;

        isDrawing = true;
        startX = e.offsetX;
        startY = e.offsetY;

        if (currentTool === 'pencil') {
            pencilPoints = [{ x: startX, y: startY }];
            ctx.beginPath();
            ctx.moveTo(startX, startY);
        } else {
            savedImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!isDrawing || !currentTool) return;

        if (currentTool === 'pencil') {
            pencilPoints.push({ x: e.offsetX, y: e.offsetY });
            ctx.lineTo(e.offsetX, e.offsetY);
            ctx.strokeStyle = colorPicker.value;
            ctx.lineWidth = parseInt(widthRange.value);
            ctx.stroke();
        } else {
            ctx.putImageData(savedImageData, 0, 0);
            const w = e.offsetX - startX;
            const h = e.offsetY - startY;

            ctx.strokeStyle = colorPicker.value;
            ctx.lineWidth = parseInt(widthRange.value);

            if (currentTool === 'rectangle') {
                ctx.strokeRect(startX, startY, w, h);
            } else if (currentTool === 'circle') {
                ctx.beginPath();
                const radius = Math.sqrt(w * w + h * h);
                ctx.arc(startX, startY, radius, 0, 2 * Math.PI);
                ctx.stroke();
            }
            else if (currentTool === 'line') {
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(e.offsetX, e.offsetY);
                ctx.stroke();
            }
            else if (currentTool === 'arrow') {
                drawArrow(ctx, startX, startY, e.offsetX, e.offsetY);
            }
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        if (!isDrawing || !currentTool) return;
        isDrawing = false;

        const w = e.offsetX - startX;
        const h = e.offsetY - startY;

        if (currentTool === 'pencil') {
            const payload = {
                type: 'stroke',
                color: colorPicker.value,
                width: parseInt(widthRange.value),
                points: pencilPoints.map(p => ({
                    x: p.x / canvas.width,
                    y: p.y / canvas.height
                }))
            };
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(payload));
            }
        } else {
            let shape = {
                type: 'shape',
                shapeType: currentTool,
                color: colorPicker.value,
                width: parseInt(widthRange.value),
                start: { x: startX / canvas.width, y: startY / canvas.height },
                end: { x: e.offsetX / canvas.width, y: e.offsetY / canvas.height }
            };
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(shape));
            }

            ctx.strokeStyle = colorPicker.value;
            ctx.lineWidth = parseInt(widthRange.value);
            if (currentTool === 'rectangle') {
                ctx.strokeRect(startX, startY, w, h);
            } else if (currentTool === 'circle') {
                ctx.beginPath();
                const radius = Math.sqrt(w * w + h * h);
                ctx.arc(startX, startY, radius, 0, 2 * Math.PI);
                ctx.stroke();
            } else if (currentTool === 'line') {
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(e.offsetX, e.offsetY);
                ctx.stroke();
            } else if (currentTool === 'arrow') {
                drawArrow(ctx, startX, startY, e.offsetX, e.offsetY);
            }

        }
    });

    canvas.addEventListener('mouseout', () => {
        if (isDrawing) {
            isDrawing = false;
            if (currentTool !== 'pencil') {
                ctx.putImageData(savedImageData, 0, 0);
            }
        }
    });

    // Upload + Interpret 
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const svgPreview = document.getElementById('svgPreview');

    async function uploadAndInterpret() {
        const file = fileInput.files[0];
        if (!file) { alert('Choose a file first'); return; }
        const formData = new FormData();
        formData.append('file', file);
        try {
            const resp = await fetch('/interpret', { method: 'POST', body: formData });
            if (!resp.ok) { throw new Error(await resp.text()); }
            const data = await resp.json();
            svgPreview.innerHTML = data.svg;
        } catch (err) {
            alert('Error: ' + err);
        }
    }

    uploadBtn.addEventListener('click', uploadAndInterpret);


    const aiBtn = document.getElementById("aiBtn");

    async function aiCleanup() {
        // 1. Get canvas as base64
        const b64img = canvas.toDataURL("image/png");

        try {
            // 2. Send to backend
            const resp = await fetch("/ai-cleanup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image: b64img })
            });

            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();

            // 3. Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // 4. Convert SVG string → image
            const svgBlob = new Blob([data.cleanedSVG], { type: "image/svg+xml;charset=utf-8" });
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();

            img.onload = function () {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
            };
            img.src = url;

            console.log("Nodes:", data.nodes);
            console.log("Edges:", data.edges);
        } catch (err) {
            alert("AI Cleanup failed: " + err);
        }
    }

    aiBtn.addEventListener("click", aiCleanup);


})();
