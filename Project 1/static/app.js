// Collaborative drawing client — action-list model (supports undo/redo + select/move + emoji)
(function () {
  const canvas = document.getElementById("c");
  const colorPicker = document.getElementById("color");
  const widthRange = document.getElementById("width");
  const clearBtn = document.getElementById("clear");
  const ctx = canvas.getContext("2d");

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    render();
  }
  window.addEventListener("resize", resize);

  // ---------------- Identity ----------------
  const clientId =
    Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);
  let actionCounter = 0;
  function genId() {
    return clientId + ":" + actionCounter++;
  }

  // ---------------- State ----------------
  let actions = []; // everything currently on the board (mine + everyone else's)
  let redoStack = []; // my own undone actions, in undo order
  let selectedId = null;

  // ---------------- WebSocket ----------------
  const loc = window.location;
  const wsProtocol = loc.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${wsProtocol}://${loc.host}/ws`;
  const ws = new WebSocket(wsUrl);

  const connStatus = document.getElementById("connStatus");
  const connStatusText = document.getElementById("connStatusText");
  function setStatus(state) {
    if (!connStatus) return;
    connStatus.classList.remove("online", "offline");
    if (state === "online") {
      connStatus.classList.add("online");
      connStatusText.textContent = "Live";
    } else if (state === "offline") {
      connStatus.classList.add("offline");
      connStatusText.textContent = "Offline";
    } else {
      connStatusText.textContent = "Connecting…";
    }
  }

  ws.addEventListener("open", () => {
    console.log("ws open");
    setStatus("online");
  });
  ws.addEventListener("close", () => {
    console.log("ws closed");
    setStatus("offline");
  });
  ws.addEventListener("error", (e) => {
    console.error("ws error", e);
    setStatus("offline");
  });

  // ---------------- Auth (user badge + logout) ----------------
  let currentUsername = null;
  (async function loadCurrentUser() {
    try {
      const resp = await fetch("/me");
      if (!resp.ok) {
        window.location.href = "/login";
        return;
      }
      const data = await resp.json();
      currentUsername = data.username;
      const badge = document.getElementById("userBadge");
      const label = document.getElementById("usernameLabel");
      if (badge && label) {
        label.textContent = data.username;
        badge.style.display = "flex";
      }
    } catch (e) {
      window.location.href = "/login";
    }
  })();

  document.getElementById("logoutBtn")?.addEventListener("click", async () => {
    try {
      await fetch("/logout", { method: "POST" });
    } catch (e) {
      /* ignore */
    }
    window.location.href = "/login";
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "add") {
        addAction(msg.action, { local: false });
      } else if (msg.type === "remove") {
        actions = actions.filter((a) => a.id !== msg.id);
        if (selectedId === msg.id) selectedId = null;
        render();
      } else if (msg.type === "update") {
        const idx = actions.findIndex((a) => a.id === msg.action.id);
        if (idx !== -1) actions[idx] = msg.action;
        render();
      } else if (msg.type === "clear") {
        actions = [];
        redoStack = [];
        selectedId = null;
        render();
      } else if (msg.type === "presence") {
        const countEl = document.getElementById("peopleCount");
        const badge = document.getElementById("peopleBadge");
        if (countEl) countEl.textContent = msg.count + " online";
        if (badge && Array.isArray(msg.users))
          badge.title = msg.users.join(", ");
      } else if (msg.type === "chat") {
        addChatMessage(msg.username, msg.text);
      }
    } catch (e) {
      console.error("bad message", e);
    }
  });

  // ---------------- Draw primitives ----------------
  function drawShape(shape) {
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.width;

    const x1 = shape.start.x * canvas.width,
      y1 = shape.start.y * canvas.height;
    const x2 = shape.end.x * canvas.width,
      y2 = shape.end.y * canvas.height;
    const w = x2 - x1,
      h = y2 - y1;

    if (shape.shapeType === "rectangle") {
      ctx.strokeRect(x1, y1, w, h);
    } else if (shape.shapeType === "circle") {
      ctx.beginPath();
      const radius = Math.sqrt(w * w + h * h);
      ctx.arc(x1, y1, radius, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (shape.shapeType === "line") {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (shape.shapeType === "arrow") {
      drawArrow(ctx, x1, y1, x2, y2);
    }
  }

  function drawStroke(stroke) {
    const points = stroke.points;
    if (!points || points.length === 0) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = stroke.color || "#000";
    ctx.lineWidth = stroke.width || 3;
    ctx.beginPath();
    ctx.moveTo(points[0].x * canvas.width, points[0].y * canvas.height);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x * canvas.width, points[i].y * canvas.height);
    }
    ctx.stroke();
  }

  function drawEmoji(action) {
    const x = action.point.x * canvas.width;
    const y = action.point.y * canvas.height;
    const size = action.size * canvas.width;
    ctx.font = `${size}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(action.char, x, y);
  }

  function drawArrow(ctx, x1, y1, x2, y2) {
    const headLength = 4 * ctx.lineWidth;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const arrowX1 = x2 - headLength * Math.cos(angle - Math.PI / 7);
    const arrowY1 = y2 - headLength * Math.sin(angle - Math.PI / 7);
    const arrowX2 = x2 - headLength * Math.cos(angle + Math.PI / 7);
    const arrowY2 = y2 - headLength * Math.sin(angle + Math.PI / 7);
    const shaftEndX = x2 - headLength * 0.6 * Math.cos(angle);
    const shaftEndY = y2 - headLength * 0.6 * Math.sin(angle);

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(shaftEndX, shaftEndY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(arrowX1, arrowY1);
    ctx.moveTo(x2, y2);
    ctx.lineTo(arrowX2, arrowY2);
    ctx.stroke();
  }

  // ---------------- Bounds / hit-testing (for select + move) ----------------
  function getBoundsPx(a) {
    if (a.type === "emoji") {
      const x = a.point.x * canvas.width;
      const y = a.point.y * canvas.height;
      const half = (a.size * canvas.width) / 2;
      return { x: x - half, y: y - half, w: half * 2, h: half * 2 };
    }

    const pad = (a.width || 3) / 2 + 4;
    if (a.type === "stroke") {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      a.points.forEach((p) => {
        const x = p.x * canvas.width,
          y = p.y * canvas.height;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      });
      return {
        x: minX - pad,
        y: minY - pad,
        w: maxX - minX + pad * 2,
        h: maxY - minY + pad * 2,
      };
    }
    const x1 = a.start.x * canvas.width,
      y1 = a.start.y * canvas.height;
    const x2 = a.end.x * canvas.width,
      y2 = a.end.y * canvas.height;
    if (a.shapeType === "circle") {
      const r = Math.hypot(x2 - x1, y2 - y1);
      return {
        x: x1 - r - pad,
        y: y1 - r - pad,
        w: (r + pad) * 2,
        h: (r + pad) * 2,
      };
    }
    const minX = Math.min(x1, x2),
      maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2),
      maxY = Math.max(y1, y2);
    return {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    };
  }

  function distToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1,
      dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = x1 + t * dx,
      projY = y1 + t * dy;
    return Math.hypot(px - projX, py - projY);
  }

  function hitTest(px, py) {
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      const tol = Math.max(10, (a.width || 3) / 2 + 6);
      if (a.type === "stroke") {
        for (const p of a.points) {
          if (
            Math.hypot(px - p.x * canvas.width, py - p.y * canvas.height) <= tol
          )
            return a;
        }
      } else if (a.type === "emoji") {
        const x = a.point.x * canvas.width;
        const y = a.point.y * canvas.height;
        const half = (a.size * canvas.width) / 2;
        if (
          px >= x - half &&
          px <= x + half &&
          py >= y - half &&
          py <= y + half
        )
          return a;
      } else {
        const x1 = a.start.x * canvas.width,
          y1 = a.start.y * canvas.height;
        const x2 = a.end.x * canvas.width,
          y2 = a.end.y * canvas.height;
        if (a.shapeType === "rectangle") {
          const minX = Math.min(x1, x2) - tol,
            maxX = Math.max(x1, x2) + tol;
          const minY = Math.min(y1, y2) - tol,
            maxY = Math.max(y1, y2) + tol;
          if (px >= minX && px <= maxX && py >= minY && py <= maxY) return a;
        } else if (a.shapeType === "circle") {
          const r = Math.hypot(x2 - x1, y2 - y1);
          if (Math.hypot(px - x1, py - y1) <= r + tol) return a;
        } else if (a.shapeType === "line" || a.shapeType === "arrow") {
          if (distToSegment(px, py, x1, y1, x2, y2) <= tol) return a;
        }
      }
    }
    return null;
  }

  function translateAction(action, dx, dy) {
    if (action.type === "stroke") {
      action.points = action.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    } else if (action.type === "emoji") {
      action.point = { x: action.point.x + dx, y: action.point.y + dy };
    } else {
      action.start = { x: action.start.x + dx, y: action.start.y + dy };
      action.end = { x: action.end.x + dx, y: action.end.y + dy };
    }
  }

  // ---------------- Render ----------------
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const a of actions) {
      if (a.type === "stroke") drawStroke(a);
      else if (a.type === "emoji") drawEmoji(a);
      else drawShape(a);
    }
    if (selectedId) {
      const a = actions.find((x) => x.id === selectedId);
      if (a) {
        const b = getBoundsPx(a);
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = "#4338ca";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      } else {
        selectedId = null;
      }
    }
  }

  // ---------------- Action add / undo / redo ----------------
  function addAction(action, opts = {}) {
    if (actions.find((a) => a.id === action.id)) return;
    actions.push(action);
    if (opts.local) redoStack = [];
    render();
  }

  function undo() {
    for (let i = actions.length - 1; i >= 0; i--) {
      if (actions[i].owner === clientId) {
        const [removed] = actions.splice(i, 1);
        redoStack.push(removed);
        if (selectedId === removed.id) selectedId = null;
        render();
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "remove", id: removed.id }));
        return;
      }
    }
  }

  function redo() {
    if (redoStack.length === 0) return;
    const action = redoStack.pop();
    actions.push(action);
    render();
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "add", action }));
  }

  document.getElementById("undoBtn").addEventListener("click", undo);
  document.getElementById("redoBtn").addEventListener("click", redo);

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (
      (e.ctrlKey || e.metaKey) &&
      (key === "y" || (key === "z" && e.shiftKey))
    ) {
      e.preventDefault();
      redo();
    } else if (key === "escape") {
      selectedId = null;
      render();
    }
  });

  function clearCanvas(send = true) {
    actions = [];
    redoStack = [];
    selectedId = null;
    render();
    if (send && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "clear" }));
    }
  }
  clearBtn.addEventListener("click", () => clearCanvas(true));

  // ---------------- Tool handling ----------------
  const buttons = {
    pencil: document.getElementById("pencilBtn"),
    rectangle: document.getElementById("rectBtn"),
    circle: document.getElementById("circleBtn"),
    line: document.getElementById("lineBtn"),
    arrow: document.getElementById("arrowBtn"),
    select: document.getElementById("selectBtn"),
  };

  let currentTool = "pencil";

  function clearActive() {
    Object.values(buttons).forEach((btn) => btn.classList.remove("active"));
  }

  // ---------------- Emoji tool (Bootstrap modal picker) ----------------
  const emojiButtons = document.querySelectorAll(".emoji-btn");
  const customEmojiInput = document.getElementById("customEmoji");
  const emojiModalEl = document.getElementById("emojiModal");
  let selectedEmoji = "😀";

  function clearEmojiActive() {
    emojiButtons.forEach((b) => b.classList.remove("active"));
  }

  function closeEmojiModal() {
    if (!emojiModalEl || typeof bootstrap === "undefined") return;
    const instance =
      bootstrap.Modal.getInstance(emojiModalEl) ||
      bootstrap.Modal.getOrCreateInstance(emojiModalEl);
    instance.hide();
  }

  function activateEmojiTool(char) {
    selectedEmoji = char;
    clearEmojiActive();
    clearActive();
    currentTool = "emoji";
    selectedId = null;
    canvas.style.cursor = "crosshair";
    render();
    closeEmojiModal();
  }

  emojiButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.classList.add("active");
      activateEmojiTool(btn.dataset.emoji);
    });
  });

  if (customEmojiInput) {
    customEmojiInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = customEmojiInput.value.trim();
        if (val) activateEmojiTool(val);
      }
    });
    customEmojiInput.addEventListener("input", () => {
      const val = customEmojiInput.value.trim();
      if (val) activateEmojiTool(val);
    });
  }

  // ---------------- Board toggle (toolbar open/close) ----------------
  const boardToggleBtn = document.getElementById("boardToggleBtn");
  const toolbarPanel = document.getElementById("toolbarPanel");
  let boardOpen = false;

  function setBoardOpen(open) {
    boardOpen = open;
    toolbarPanel?.classList.toggle("open", open);
    if (boardToggleBtn) {
      boardToggleBtn.innerHTML = open
        ? '<i class="bi bi-x-lg"></i>'
        : '<i class="bi bi-list"></i>';
      boardToggleBtn.title = open ? "Close board tools" : "Open board tools";
    }
  }

  boardToggleBtn?.addEventListener("click", () => setBoardOpen(!boardOpen));

  // ---------------- Chat ----------------
  const chatToggleBtn = document.getElementById("chatToggleBtn");
  const chatCloseBtn = document.getElementById("chatCloseBtn");
  const chatPanel = document.getElementById("chatPanel");
  const chatMessages = document.getElementById("chatMessages");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatUnreadBadge = document.getElementById("chatUnreadBadge");

  let chatOpen = false;
  let unreadCount = 0;

  function updateUnreadBadge() {
    if (!chatUnreadBadge) return;
    if (unreadCount > 0) {
      chatUnreadBadge.textContent =
        unreadCount > 9 ? "9+" : String(unreadCount);
      chatUnreadBadge.classList.remove("d-none");
    } else {
      chatUnreadBadge.classList.add("d-none");
    }
  }

  function setChatOpen(open) {
    chatOpen = open;
    chatPanel?.classList.toggle("open", open);
    if (open) {
      unreadCount = 0;
      updateUnreadBadge();
      chatInput?.focus();
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  chatToggleBtn?.addEventListener("click", () => setChatOpen(!chatOpen));
  chatCloseBtn?.addEventListener("click", () => setChatOpen(false));

  function addChatMessage(username, text, opts = {}) {
    if (!chatMessages) return;
    const wrap = document.createElement("div");
    const mine = username === currentUsername;
    wrap.className =
      "chat-msg " + (opts.system ? "system" : mine ? "mine" : "theirs");

    if (opts.system) {
      wrap.textContent = text;
    } else {
      const userLine = document.createElement("span");
      userLine.className = "chat-msg-user";
      userLine.textContent = mine ? "You" : username;
      const body = document.createElement("div");
      body.textContent = text;
      wrap.appendChild(userLine);
      wrap.appendChild(body);
    }

    chatMessages.appendChild(wrap);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (!opts.system && !mine && !chatOpen) {
      unreadCount++;
      updateUnreadBadge();
    }
  }

  chatForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    const action = {
      type: "chat",
      username: currentUsername || "anonymous",
      text,
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(action));
    }
    chatInput.value = "";
  });

  let isDrawing = false;
  let startX, startY;
  let pencilPoints = [];

  let isDraggingSelection = false;
  let dragOrigAction = null;
  let dragStartX, dragStartY;

  function selectTool(tool) {
    if (currentTool === tool) {
      currentTool = null;
      clearActive();
    } else {
      currentTool = tool;
      clearActive();
      clearEmojiActive();
      buttons[tool].classList.add("active");
    }
    if (tool !== "select") {
      selectedId = null;
      render();
    }
    canvas.style.cursor = tool === "select" ? "default" : "crosshair";
  }

  buttons.pencil.onclick = () => selectTool("pencil");
  buttons.rectangle.onclick = () => selectTool("rectangle");
  buttons.circle.onclick = () => selectTool("circle");
  buttons.line.onclick = () => selectTool("line");
  buttons.arrow.onclick = () => selectTool("arrow");
  buttons.select.onclick = () => selectTool("select");

  // ---------------- Double-click to move a shape ----------------
  function activateSelectForAction(action) {
    currentTool = "select";
    clearActive();
    clearEmojiActive();
    buttons.select.classList.add("active");
    canvas.style.cursor = "move";
    selectedId = action.id;
    render();
  }

  canvas.addEventListener("dblclick", (e) => {
    const hit = hitTest(e.offsetX, e.offsetY);
    if (hit) {
      activateSelectForAction(hit);
    }
  });

  // ---------------- Pointer events ----------------
  canvas.addEventListener("mousedown", (e) => {
    if (!currentTool) return;
    startX = e.offsetX;
    startY = e.offsetY;

    if (currentTool === "select") {
      const hit = hitTest(startX, startY);
      if (hit) {
        selectedId = hit.id;
        dragOrigAction = JSON.parse(JSON.stringify(hit));
        dragStartX = startX;
        dragStartY = startY;
        isDraggingSelection = true;
      } else {
        selectedId = null;
      }
      render();
      return;
    }

    if (currentTool === "emoji") {
      const action = {
        id: genId(),
        owner: clientId,
        type: "emoji",
        char: selectedEmoji,
        point: { x: startX / canvas.width, y: startY / canvas.height },
        size: (20 + parseInt(widthRange.value) * 3) / canvas.width,
      };
      addAction(action, { local: true });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "add", action }));
      }
      return;
    }

    isDrawing = true;
    if (currentTool === "pencil") {
      pencilPoints = [{ x: startX, y: startY }];
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (currentTool === "select") {
      if (isDraggingSelection && selectedId) {
        const dx = (e.offsetX - dragStartX) / canvas.width;
        const dy = (e.offsetY - dragStartY) / canvas.height;
        const translated = JSON.parse(JSON.stringify(dragOrigAction));
        translateAction(translated, dx, dy);
        const idx = actions.findIndex((a) => a.id === selectedId);
        if (idx !== -1) actions[idx] = translated;
        render();
      } else {
        canvas.style.cursor = hitTest(e.offsetX, e.offsetY)
          ? "move"
          : "default";
      }
      return;
    }

    if (!isDrawing || !currentTool) return;

    if (currentTool === "pencil") {
      pencilPoints.push({ x: e.offsetX, y: e.offsetY });
      render();
      drawStroke({
        color: colorPicker.value,
        width: parseInt(widthRange.value),
        points: pencilPoints.map((p) => ({
          x: p.x / canvas.width,
          y: p.y / canvas.height,
        })),
      });
    } else {
      render();
      drawShape({
        shapeType: currentTool,
        color: colorPicker.value,
        width: parseInt(widthRange.value),
        start: { x: startX / canvas.width, y: startY / canvas.height },
        end: { x: e.offsetX / canvas.width, y: e.offsetY / canvas.height },
      });
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (currentTool === "select") {
      if (isDraggingSelection) {
        isDraggingSelection = false;
        const a = actions.find((x) => x.id === selectedId);
        if (a && ws.readyState === WebSocket.OPEN) {
          redoStack = [];
          ws.send(JSON.stringify({ type: "update", action: a }));
        }
      }
      return;
    }

    if (currentTool === "emoji") return; // stamped on mousedown

    if (!isDrawing || !currentTool) return;
    isDrawing = false;

    let action;
    if (currentTool === "pencil") {
      if (pencilPoints.length < 2) {
        render();
        return;
      }
      action = {
        id: genId(),
        owner: clientId,
        type: "stroke",
        color: colorPicker.value,
        width: parseInt(widthRange.value),
        points: pencilPoints.map((p) => ({
          x: p.x / canvas.width,
          y: p.y / canvas.height,
        })),
      };
    } else {
      action = {
        id: genId(),
        owner: clientId,
        type: "shape",
        shapeType: currentTool,
        color: colorPicker.value,
        width: parseInt(widthRange.value),
        start: { x: startX / canvas.width, y: startY / canvas.height },
        end: { x: e.offsetX / canvas.width, y: e.offsetY / canvas.height },
      };
    }

    addAction(action, { local: true });
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "add", action }));
    }
  });

  canvas.addEventListener("mouseout", () => {
    if (isDrawing) {
      isDrawing = false;
      render();
    }
    if (isDraggingSelection) {
      isDraggingSelection = false;
    }
  });

  // ---------------- Upload + Interpret ----------------
  const fileInput = document.getElementById("fileInput");
  const uploadBtn = document.getElementById("uploadBtn");

  function renderSVGOntoCanvas(svgText) {
    const svgBlob = new Blob([svgText], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = function () {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  async function uploadAndInterpret() {
    const file = fileInput.files[0];
    if (!file) {
      alert("Choose a file first");
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    try {
      const resp = await fetch("/interpret", {
        method: "POST",
        body: formData,
      });
      if (!resp.ok) {
        throw new Error(await resp.text());
      }
      const data = await resp.json();
      renderSVGOntoCanvas(data.svg);
      currentSVG = data.svg;
      currentNodes = data.nodes || [];
      currentEdges = data.edges || [];
    } catch (err) {
      alert("Error: " + err);
    }
  }
  uploadBtn.addEventListener("click", uploadAndInterpret);

  let currentSVG = null;
  let currentNodes = [];
  let currentEdges = [];

  async function aiCleanup() {
    const b64img = canvas.toDataURL("image/png");
    const resp = await fetch("/ai-cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b64img }),
    });
    const data = await resp.json();
    currentSVG = data.cleanedSVG;
    currentNodes = data.nodes || [];
    currentEdges = data.edges || [];
  }

  // ---------------- Save / Load ----------------
  const saveChannel = new BroadcastChannel("diagram-save");
  const channel = new BroadcastChannel("diagram_sync");

  saveChannel.onmessage = (event) => {
    if (event.data.type === "save") {
      console.log("🔄 Received save request:", event.data);
      alert("ℹ️ Diagram saved in another tab: " + event.data.payload.title);
    }
  };

  async function saveDiagram() {
    const title = prompt("Diagram name?");
    if (title === null) {
      alert("❌ Save cancelled.");
      return;
    }

    const fallbackSVG = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}">
            <image href="${canvas.toDataURL("image/png")}" width="100%" height="100%" />
        </svg>
    `;

    const payload = {
      title: title.trim() || "Untitled",
      svg: currentSVG || fallbackSVG,
      nodes: currentNodes,
      edges: currentEdges,
      user_id: "u1",
    };

    try {
      const resp = await fetch("/diagrams/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await resp.text();
      if (!resp.ok)
        throw new Error("Save failed: " + resp.status + " → " + text);
      JSON.parse(text);
      alert("✅ Saved! ");
      await fetchDiagramList();
      channel.postMessage({ type: "refresh_list" });
    } catch (err) {
      console.error("❌ Error saving diagram:", err);
      alert("❌ Failed to save: " + err.message);
    }
  }

  async function fetchDiagramList() {
    try {
      const resp = await fetch("/diagrams/list");
      if (!resp.ok) throw new Error("Failed to fetch list");
      const list = await resp.json();
      const select = document.getElementById("diagramList");
      select.innerHTML = "";
      list.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent =
          d.title + " (" + new Date(d.created_at).toLocaleString() + ")";
        select.appendChild(opt);
      });
    } catch (err) {
      console.error("Error fetching list:", err);
    }
  }

  async function loadDiagram(diagramId = null) {
    if (!diagramId) {
      const select = document.getElementById("diagramList");
      diagramId = select?.value;
    }
    if (!diagramId) {
      alert("⚠️ Select a diagram first");
      return;
    }

    try {
      const resp = await fetch(`/diagrams/${diagramId}`);
      if (!resp.ok) throw new Error("Failed to load diagram");
      const data = await resp.json();

      // Loaded diagrams come in as a flat image (legacy save format),
      // so they're dropped on the canvas as a background rather than
      // becoming editable actions.
      actions = [];
      redoStack = [];
      selectedId = null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (data.svg) {
        const svgText =
          typeof data.svg === "string" ? data.svg : JSON.stringify(data.svg);
        const svgBlob = new Blob([svgText], {
          type: "image/svg+xml;charset=utf-8",
        });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        img.onload = function () {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
        };
        img.src = url;
      }

      currentSVG = data.svg;
      currentNodes = data.nodes || [];
      currentEdges = data.edges || [];

      alert("✅ Diagram loaded: " + data.title);
      channel.postMessage({ type: "load", id: diagramId });
    } catch (err) {
      console.error("❌ Error loading diagram:", err);
      alert("❌ Failed to load: " + err.message);
    }
  }

  channel.onmessage = async (event) => {
    const msg = event.data;
    if (msg.type === "refresh_list") {
      await fetchDiagramList();
    }
    if (msg.type === "load") {
      try {
        const resp = await fetch(`/diagrams/${msg.id}`);
        if (!resp.ok) throw new Error("Failed to load diagram");
        const data = await resp.json();
        currentSVG = data.svg;
        currentNodes = data.nodes || [];
        currentEdges = data.edges || [];
      } catch (err) {
        console.error("❌ Error syncing diagram:", err);
      }
    }
  };

  window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("saveBtn").addEventListener("click", saveDiagram);
    document.getElementById("loadBtn").addEventListener("click", loadDiagram);
    fetchDiagramList();
  });

  resize();
})();
