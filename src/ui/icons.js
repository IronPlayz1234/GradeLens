(() => {
  const app = globalThis.MBGC;
  // Navigation glyphs from Lucide (ISC). See assets/LUCIDE-LICENSE.txt.
  const shapes = {
    workspace: [["rect", {"width": "7", "height": "9", "x": "3", "y": "3", "rx": "1"}], ["rect", {"width": "7", "height": "5", "x": "14", "y": "3", "rx": "1"}], ["rect", {"width": "7", "height": "9", "x": "14", "y": "12", "rx": "1"}], ["rect", {"width": "7", "height": "5", "x": "3", "y": "16", "rx": "1"}]],
    calendar: [["path", {"d": "M8 2v4"}], ["path", {"d": "M16 2v4"}], ["rect", {"width": "18", "height": "18", "x": "3", "y": "4", "rx": "2"}], ["path", {"d": "M3 10h18"}], ["path", {"d": "M8 14h.01"}], ["path", {"d": "M12 14h.01"}], ["path", {"d": "M16 14h.01"}], ["path", {"d": "M8 18h.01"}], ["path", {"d": "M12 18h.01"}], ["path", {"d": "M16 18h.01"}]],
    tasks: [["rect", {"width": "8", "height": "4", "x": "8", "y": "2", "rx": "1", "ry": "1"}], ["path", {"d": "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"}], ["path", {"d": "m9 14 2 2 4-4"}]],
    grades: [["line", {"x1": "12", "x2": "12", "y1": "20", "y2": "10"}], ["line", {"x1": "18", "x2": "18", "y1": "20", "y2": "4"}], ["line", {"x1": "6", "x2": "6", "y1": "20", "y2": "16"}]],
    estimator: [["line", {"x1": "21", "x2": "14", "y1": "4", "y2": "4"}], ["line", {"x1": "10", "x2": "3", "y1": "4", "y2": "4"}], ["line", {"x1": "21", "x2": "12", "y1": "12", "y2": "12"}], ["line", {"x1": "8", "x2": "3", "y1": "12", "y2": "12"}], ["line", {"x1": "21", "x2": "16", "y1": "20", "y2": "20"}], ["line", {"x1": "12", "x2": "3", "y1": "20", "y2": "20"}], ["line", {"x1": "14", "x2": "14", "y1": "2", "y2": "6"}], ["line", {"x1": "8", "x2": "8", "y1": "10", "y2": "14"}], ["line", {"x1": "16", "x2": "16", "y1": "18", "y2": "22"}]],
    refresh: [["path", {"d": "M20 7v5h-5M4 17v-5h5m11 0a8 8 0 0 0-14-5m-2 5a8 8 0 0 0 14 5"}]],
    chevron: [["path", {"d": "m6 9 6 6 6-6"}]],
    arrow: [["path", {"d": "M4 12h15m-6-6 6 6-6 6"}]],
    external: [["path", {"d": "M13 5h6v6m0-6-9 9m7-2v7H5V7h7"}]],
    search: [["path", {"d": "M17 17l4 4m-2-10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"}]],
    close: [["path", {"d": "m6 6 12 12M18 6 6 18"}]],
    settings: [["path", {"d": "M4 7h16M4 17h16M8 4v6m8 4v6"}]],
    book: [["path", {"d": "M5 4h13a1 1 0 0 1 1 1v15H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1Zm0 12h14M8 8h7"}]],
    plus: [["path", {"d": "M12 5v14M5 12h14"}]],
    target: [["path", {"d": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-5h.01"}]],
    clock: [["path", {"d": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2"}]],
    info: [["path", {"d": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v5m0-8h.01"}]],
    alert: [["path", {"d": "M10.3 4.6 2.6 18a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 4.6a2 2 0 0 0-3.4 0ZM12 9v4m0 3h.01"}]],
    timetable: [["path", {"d": "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"}], ["path", {"d": "M16 2v4"}], ["path", {"d": "M8 2v4"}], ["path", {"d": "M3 10h5"}], ["path", {"d": "M17.5 17.5 16 16.3V14"}], ["circle", {"cx": "16", "cy": "16", "r": "6"}]],
  };
  const svgNS = "http://www.w3.org/2000/svg";
  function icon(name) {
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('mbgc-glyph');
    svg.dataset.mbgcIcon = name;
    for (const [tag, attributes] of shapes[name] ?? []) {
      const shape = document.createElementNS(svgNS, tag);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
      svg.append(shape);
    }
    return svg;
  }
  Object.assign(app, { icon });
})();
