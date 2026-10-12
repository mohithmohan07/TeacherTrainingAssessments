// Minimal DOM for the report renderer's structural contract. This does not
// claim browser layout or image-decoding coverage; optional Chromium QA does.
const escape = (value) => String(value).replace(/[&<>\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
export class ReportNode {
  constructor(tag, text = '') { this.tag = tag; this.text = text; this.attributes = {}; this.children = []; this.style = {}; this.dataset = {}; this.complete = true; this.isConnected = true; }
  set className(value) { this.attributes.class = value; }
  get className() { return this.attributes.class ?? ''; }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key.startsWith('data-')) this.dataset[key.slice(5)] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener() {}
  append(...nodes) { this.children.push(...nodes.map((node) => node instanceof ReportNode ? node : new ReportNode('#text', String(node)))); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get textContent() { return this.tag === '#text' ? this.text : this.children.map((node) => node.textContent).join(''); }
  get innerText() { return this.tag === '#text' ? this.text : this.children.map((node) => node.innerText).join(' '); }
  get outerHTML() {
    if (this.tag === '#text') return escape(this.text);
    return `<${this.tag}${Object.entries(this.attributes).map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}>${this.children.map((node) => node.outerHTML).join('')}</${this.tag}>`;
  }
  querySelectorAll(selector) {
    const match = (node) => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector;
    return this.children.flatMap((node) => [...(match(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getContext() { return { fillRect() {}, drawImage() {} }; }
  toBlob(callback) { callback(new Blob(['synthetic image'], { type: 'image/png' })); }
}
export function installReportDom(payloads) {
  const before = { Node: globalThis.Node, document: globalThis.document, fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap };
  globalThis.Node = ReportNode;
  globalThis.document = { createElement: (tag) => new ReportNode(tag), createElementNS: (_ns, tag) => new ReportNode(tag), createTextNode: (text) => new ReportNode('#text', text) };
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  globalThis.fetch = async (url) => {
    const payload = url.startsWith('/api/reports/school') ? payloads.school : url.startsWith('/api/reports/teacher') ? payloads.teacher : null;
    return payload ? new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }) : new Response(new Blob(['synthetic scan'], { type: 'image/png' }));
  };
  return () => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } };
}
