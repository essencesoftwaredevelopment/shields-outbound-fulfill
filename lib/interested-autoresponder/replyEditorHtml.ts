const HTML_TAG_PATTERN = /<\/?[a-z][\s\S]*>/i;

const FONT_STYLE_DECL_PATTERN =
    /^\s*(?:font(?:\s|-|$)|font-family|font-size|font-weight|font-style|font-variant|line-height|-webkit-font)/i;

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function linkifyPlainText(text: string): string {
    return escapeHtml(text).replace(/https?:\/\/[^\s<>"']+/g, (url) => {
        const href = url.replace(/"/g, "&quot;");
        return `<a href="${href}">${url}</a>`;
    });
}

function cleanStyleAttribute(style: string): string {
    return style
        .split(";")
        .map((decl) => decl.trim())
        .filter(Boolean)
        .filter((decl) => !FONT_STYLE_DECL_PATTERN.test(decl))
        .join("; ");
}

function unwrapElement(el: Element) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) {
        parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
}

export function isReplyEditorHtml(text: string): boolean {
    return HTML_TAG_PATTERN.test(String(text || ""));
}

export function plainTextToReplyEditorHtml(text: string): string {
    const trimmed = String(text || "").trim();
    if (!trimmed) return "";
    if (isReplyEditorHtml(trimmed)) return normalizeReplyEditorHtml(trimmed);

    return trimmed
        .split(/\n{2,}/)
        .map((paragraph) => {
            const inner = linkifyPlainText(paragraph).replace(/\n/g, "<br>");
            return `<p>${inner}</p>`;
        })
        .join("");
}

export function normalizeReplyEditorHtml(html: string): string {
    const trimmed = String(html || "").trim();
    if (!trimmed) return "";
    if (typeof document === "undefined") return trimmed;

    const doc = new DOMParser().parseFromString(`<div id="reply-editor-root">${trimmed}</div>`, "text/html");
    const root = doc.getElementById("reply-editor-root");
    if (!root) return trimmed;

    const elements = [...root.querySelectorAll("*")];
    for (let index = elements.length - 1; index >= 0; index -= 1) {
        const el = elements[index];
        const tag = el.tagName.toLowerCase();

        if (tag === "font") {
            unwrapElement(el);
            continue;
        }

        if (el.hasAttribute("style")) {
            const cleaned = cleanStyleAttribute(el.getAttribute("style") || "");
            if (cleaned) el.setAttribute("style", cleaned);
            else el.removeAttribute("style");
        }

        if (tag === "span" && !el.hasAttributes()) {
            unwrapElement(el);
        }
    }

    [...root.querySelectorAll("span")].reverse().forEach((el) => {
        if (!el.hasAttributes()) unwrapElement(el);
    });

    return root.innerHTML.trim();
}

export function prepareReplyEditorContent(text: string): string {
    const trimmed = String(text || "").trim();
    if (!trimmed) return "";
    if (isReplyEditorHtml(trimmed)) return normalizeReplyEditorHtml(trimmed);
    return plainTextToReplyEditorHtml(trimmed);
}
