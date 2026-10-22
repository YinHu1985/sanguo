// Geography stays in external SVG/JSON; this controller only handles the camera.
export class StrategicMap {
  constructor({ viewport, world, projection, onCityClick }) {
    this.viewport = viewport;
    this.world = world;
    this.projection = projection;
    this.onCityClick = onCityClick;
    this.camera = { x: 0, y: 0, scale: 1 };
    this.cities = [];
    this.showRoutes = false;
    this.showLabels = true;
    this.initialized = false;
    this.world.style.width = `${projection.width}px`;
    this.world.style.height = `${projection.height}px`;
    this.bindEvents();
    new ResizeObserver(() => {
      if (!this.viewport.clientHeight) return;
      if (!this.initialized) this.fit();
      else { this.clampCamera(); this.paint(); }
    }).observe(viewport);
  }

  get fitScale() {
    return Math.min((this.viewport.clientWidth - 40) / this.projection.width, (this.viewport.clientHeight - 170) / this.projection.height);
  }

  setCities(cities, selectedId) {
    this.cities = cities;
    this.selectedId = selectedId;
    this.applyRouteVisibility();
    this.paint();
  }

  fit() {
    const { width, height } = this.projection;
    this.camera.scale = Math.max(0.15, this.fitScale);
    this.camera.x = (this.viewport.clientWidth - width * this.camera.scale) / 2;
    this.camera.y = 80 + (this.viewport.clientHeight - 170 - height * this.camera.scale) / 2;
    this.initialized = true;
    this.paint();
  }

  focusCities(cities, { detail = false } = {}) {
    if (!cities.length) return;
    const xs = cities.map((city) => city.x);
    const ys = cities.map((city) => city.y);
    const bounds = { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
    const safeWidth = Math.max(320, this.viewport.clientWidth - (detail ? 340 : 140));
    const safeHeight = Math.max(300, this.viewport.clientHeight - 240);
    const scale = cities.length === 1
      ? Math.max(this.camera.scale, this.fitScale * 2.8)
      : Math.min(safeWidth / Math.max(330, bounds.right - bounds.left + 160), safeHeight / Math.max(280, bounds.bottom - bounds.top + 150));
    this.camera.scale = Math.max(this.fitScale, Math.min(this.fitScale * 6, scale));
    this.camera.x = (detail ? safeWidth / 2 + 20 : this.viewport.clientWidth / 2) - (bounds.left + bounds.right) / 2 * this.camera.scale;
    this.camera.y = 90 + safeHeight / 2 - (bounds.top + bounds.bottom) / 2 * this.camera.scale;
    this.clampCamera();
    this.paint();
  }

  zoom(factor, anchor = { x: this.viewport.clientWidth / 2, y: this.viewport.clientHeight / 2 }) {
    const oldScale = this.camera.scale;
    const newScale = Math.min(this.fitScale * 6, Math.max(this.fitScale * 0.8, oldScale * factor));
    this.camera.x = anchor.x - (anchor.x - this.camera.x) * newScale / oldScale;
    this.camera.y = anchor.y - (anchor.y - this.camera.y) * newScale / oldScale;
    this.camera.scale = newScale;
    this.clampCamera();
    this.paint();
  }

  clampCamera() {
    const { width, height } = this.projection;
    const margin = 140;
    this.camera.x = Math.min(this.viewport.clientWidth - margin, Math.max(margin - width * this.camera.scale, this.camera.x));
    this.camera.y = Math.min(this.viewport.clientHeight - margin, Math.max(margin - height * this.camera.scale, this.camera.y));
  }

  paint() {
    const { x, y, scale } = this.camera;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    this.world.style.setProperty("--marker-scale", 1 / scale);
    document.querySelector("#map-zoom-level").textContent = `${Math.round(scale / this.fitScale * 100)}%`;
    cancelAnimationFrame(this.labelFrame);
    this.labelFrame = requestAnimationFrame(() => this.layoutLabels());
  }

  layoutLabels() {
    // At overview scale, retain all city markers and declutter only overlapping names.
    const priority = new Set(["luoyang", "changan", "chengdu", "hanzhong", "xiangyang", "jiangling", "jianye", "wuwei", "beiping", "xiangping", "ye", "changsha", "nanhai", "jiaozhi", "kunming", "yunnan", "wan", "xuchang"]);
    const nodes = [...this.world.querySelectorAll(".city-node")];
    nodes.sort((a, b) => {
      const rank = (node) => node.classList.contains("active") ? 0 : node.classList.contains("owned") ? 1 : priority.has(node.dataset.cityId) ? 2 : 3;
      return rank(a) - rank(b);
    });
    const occupied = [];
    for (const node of nodes) {
      node.classList.remove("label-hidden");
      const label = node.querySelector(".node-label");
      const rect = label.getBoundingClientRect();
      const overlap = occupied.some((other) => rect.left < other.right + 5 && rect.right > other.left - 5 && rect.top < other.bottom + 3 && rect.bottom > other.top - 3);
      const hidden = !this.showLabels || (overlap && !node.classList.contains("active"));
      node.classList.toggle("label-hidden", hidden);
      if (!hidden) occupied.push(rect);
    }
  }

  applyRouteVisibility() {
    this.world.classList.toggle("show-all-routes", this.showRoutes);
    this.world.querySelectorAll(".route-line").forEach((line) => {
      const selected = line.dataset.from === this.selectedId || line.dataset.to === this.selectedId;
      line.classList.toggle("selected-route", selected);
    });
  }

  bindEvents() {
    let drag = null;
    this.viewport.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: this.camera.x, y: this.camera.y, moved: false };
      // Keep ordinary button clicks intact; capture only once a real drag begins.
    });
    this.viewport.addEventListener("pointermove", (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 5) {
        drag.moved = true;
        this.viewport.setPointerCapture(event.pointerId);
        this.viewport.classList.add("is-dragging");
      }
      if (!drag.moved) return;
      this.camera.x = drag.x + dx;
      this.camera.y = drag.y + dy;
      this.clampCamera();
      this.paint();
    });
    const finishDrag = (event) => {
      if (!drag) return;
      this.suppressClick = drag.moved;
      if (this.viewport.hasPointerCapture(event.pointerId)) this.viewport.releasePointerCapture(event.pointerId);
      this.viewport.classList.remove("is-dragging");
      drag = null;
      window.setTimeout(() => { this.suppressClick = false; }, 0);
    };
    this.viewport.addEventListener("pointerup", finishDrag);
    this.viewport.addEventListener("pointercancel", finishDrag);
    this.viewport.addEventListener("click", (event) => {
      if (this.suppressClick) return;
      const node = event.target.closest("[data-city-id]");
      if (node) this.onCityClick(node.dataset.cityId);
    });
    this.viewport.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      this.zoom(Math.exp(-event.deltaY * 0.0017), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });
    this.viewport.addEventListener("keydown", (event) => {
      const moves = { ArrowLeft: [70, 0], ArrowRight: [-70, 0], ArrowUp: [0, 70], ArrowDown: [0, -70] };
      if (moves[event.key]) {
        event.preventDefault();
        this.camera.x += moves[event.key][0];
        this.camera.y += moves[event.key][1];
        this.clampCamera(); this.paint();
      } else if (["+", "="].includes(event.key)) { event.preventDefault(); this.zoom(1.25); }
      else if (event.key === "-") { event.preventDefault(); this.zoom(0.8); }
    });
  }
}
