"use client";

import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
    type ClipboardEvent,
    type DragEvent,
    type FormEvent,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent,
} from "react";

/**
 * WYSIWYG composer for free-hand lead replies. What you see is what goes out:
 * URLs become blue links as you type, images sit inline wherever the caret
 * is (paste, drop or the Attach button) and resize by dragging their corner
 * handle (stored as the <img width> attribute, which the server keeps), and
 * the innerHTML is what the server sanitizes and sends. Keeps the parent out
 * of per-keystroke re-renders — onChange fires only when emptiness / upload
 * count / image count change; the HTML is pulled with getHtml() at send time.
 */

export type LeadReplyEditorState = {
    isEmpty: boolean;
    uploading: number;
    imageCount: number;
};

export type LeadReplyEditorHandle = {
    insertImages: (files: File[]) => void;
    getHtml: () => string;
    clear: () => void;
    focus: () => void;
};

type Props = {
    disabled?: boolean;
    placeholder?: string;
    maxImages: number;
    acceptedMimeTypes: Set<string>;
    /** Resolve to the hosted URL, or null when the upload failed (the caller reports why). */
    uploadImage: (file: File) => Promise<{ url: string } | null>;
    onChange: (state: LeadReplyEditorState) => void;
    onNotice: (message: string) => void;
    onSubmit?: () => void;
};

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
const MIN_IMAGE_WIDTH = 40;

function escapeHtml(text: string) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function hrefFor(url: string) {
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** URL matches in a string, with trailing sentence punctuation left out of the link. */
function findUrls(text: string) {
    const matches: Array<{ start: number; end: number; url: string }> = [];
    for (const match of text.matchAll(URL_PATTERN)) {
        const raw = match[0];
        const url = raw.replace(TRAILING_PUNCTUATION, "");
        if (!url || url === "www.") continue;
        matches.push({ start: match.index ?? 0, end: (match.index ?? 0) + url.length, url });
    }
    return matches;
}

function plainTextToHtml(text: string) {
    return text
        .replace(/\r\n|\r/g, "\n")
        .split("\n")
        .map((line) => {
            let html = "";
            let cursor = 0;
            for (const { start, end, url } of findUrls(line)) {
                html += escapeHtml(line.slice(cursor, start));
                html += `<a href="${escapeHtml(hrefFor(url))}">${escapeHtml(url)}</a>`;
                cursor = end;
            }
            return html + escapeHtml(line.slice(cursor));
        })
        .join("<br>");
}

function placeCaretAtEnd(root: HTMLElement) {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

/**
 * Wrap bare URLs in text nodes (outside existing links) with <a>. Unless
 * `force`, a URL the caret is still at the end of is left alone — the user
 * may not be done typing it. No caret bookkeeping: splitText() keeps live
 * ranges pointing at the same character, so the caret stays where it was.
 */
function linkifyTextNodes(root: HTMLElement, force: boolean) {
    const selection = window.getSelection();
    const caretNode = selection?.rangeCount ? selection.getRangeAt(0).startContainer : null;
    const caretPos = selection?.rangeCount ? selection.getRangeAt(0).startOffset : 0;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest("a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const textNodes: Text[] = [];
    let current = walker.nextNode() as Text | null;
    while (current) {
        textNodes.push(current);
        current = walker.nextNode() as Text | null;
    }

    for (const textNode of textNodes) {
        const matches = findUrls(textNode.data).reverse();
        for (const { start, end, url } of matches) {
            if (!force && textNode === caretNode && end >= caretPos) continue;
            const after = textNode.splitText(end);
            const urlNode = textNode.splitText(start);
            const anchor = document.createElement("a");
            anchor.href = hrefFor(url);
            anchor.textContent = url;
            urlNode.replaceWith(anchor);
            if (!after.data) after.remove();
        }
    }
}

function insertNodeAtCaret(root: HTMLElement, node: Node) {
    const selection = window.getSelection();
    let range: Range;
    if (selection?.rangeCount && root.contains(selection.getRangeAt(0).startContainer)) {
        range = selection.getRangeAt(0);
        range.deleteContents();
    } else {
        range = document.createRange();
        range.selectNodeContents(root);
        range.collapse(false);
    }
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
}

function caretRangeFromPoint(x: number, y: number): Range | null {
    const doc = document as Document & {
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    if (typeof doc.caretRangeFromPoint === "function") return doc.caretRangeFromPoint(x, y);
    if (typeof doc.caretPositionFromPoint === "function") {
        const position = doc.caretPositionFromPoint(x, y);
        if (!position) return null;
        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
    }
    return null;
}

export const LeadReplyEditor = forwardRef<LeadReplyEditorHandle, Props>(function LeadReplyEditor(
    { disabled = false, placeholder, maxImages, acceptedMimeTypes, uploadImage, onChange, onNotice, onSubmit },
    ref,
) {
    const rootRef = useRef<HTMLDivElement>(null);
    const frameRef = useRef<HTMLDivElement>(null);
    const uploadingRef = useRef(0);
    const previewUrlsRef = useRef(new Set<string>());
    const lastStateRef = useRef<LeadReplyEditorState>({ isEmpty: true, uploading: 0, imageCount: 0 });
    const [dragging, setDragging] = useState(false);
    // Image resizing: the selected <img> gets an outline and a corner handle
    // (a sibling of the editable div, so it never becomes editable content).
    const [selectedImage, setSelectedImage] = useState<HTMLImageElement | null>(null);
    const [resizeWidth, setResizeWidth] = useState<number | null>(null);
    const handleRef = useRef<HTMLDivElement>(null);
    const sizeLabelRef = useRef<HTMLSpanElement>(null);
    const resizeRef = useRef<{ image: HTMLImageElement; startX: number; startWidth: number; maxWidth: number } | null>(null);

    const selectImage = useCallback((image: HTMLImageElement | null) => {
        setSelectedImage((previous) => {
            if (previous && previous !== image) previous.removeAttribute("data-selected");
            if (image) image.setAttribute("data-selected", "1");
            return image;
        });
    }, []);

    // Pins the handle (and the size label while dragging) to the selected
    // image's bottom-right corner. Imperative on purpose: layout reads after
    // every keystroke / image load would otherwise mean setState in effects.
    const updateHandleBox = useCallback(() => {
        const frame = frameRef.current;
        const image = selectedImage;
        const handle = handleRef.current;
        if (!frame || !handle) return;
        if (!image || !rootRef.current?.contains(image)) {
            handle.hidden = true;
            if (sizeLabelRef.current) sizeLabelRef.current.hidden = true;
            return;
        }
        const frameRect = frame.getBoundingClientRect();
        const rect = image.getBoundingClientRect();
        const left = `${rect.right - frameRect.left}px`;
        const top = `${rect.bottom - frameRect.top}px`;
        handle.hidden = false;
        handle.style.left = left;
        handle.style.top = top;
        handle.setAttribute("aria-valuenow", String(Math.round(rect.width)));
        if (sizeLabelRef.current) {
            sizeLabelRef.current.style.left = left;
            sizeLabelRef.current.style.top = top;
        }
    }, [selectedImage]);

    useLayoutEffect(() => {
        updateHandleBox();
        if (!selectedImage) return;
        window.addEventListener("resize", updateHandleBox);
        return () => window.removeEventListener("resize", updateHandleBox);
    }, [selectedImage, updateHandleBox]);

    const readState = useCallback((): LeadReplyEditorState => {
        const root = rootRef.current;
        const imageCount = root?.querySelectorAll("img").length ?? 0;
        const hasText = Boolean(root?.textContent?.trim());
        return { isEmpty: !hasText && imageCount === 0, uploading: uploadingRef.current, imageCount };
    }, []);

    // A blank editor (only <p><br></p> left) is made truly empty so the CSS placeholder shows again.
    const emit = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        if (!root.querySelector("img") && !root.textContent && root.innerHTML !== "") {
            root.innerHTML = "";
        }
        setSelectedImage((current) => (current && root.contains(current) ? current : null));
        updateHandleBox();
        const next = readState();
        const previous = lastStateRef.current;
        if (
            next.isEmpty !== previous.isEmpty
            || next.uploading !== previous.uploading
            || next.imageCount !== previous.imageCount
        ) {
            lastStateRef.current = next;
            onChange(next);
        }
    }, [onChange, readState, updateHandleBox]);

    const insertImages = useCallback((files: File[]) => {
        const root = rootRef.current;
        if (!root || disabled) return;
        const valid = files.filter((file) => acceptedMimeTypes.has(file.type));
        if (!valid.length) {
            onNotice("Only PNG, JPEG, GIF or WebP images can be attached.");
            return;
        }
        const room = maxImages - root.querySelectorAll("img").length;
        if (room <= 0) {
            onNotice(`At most ${maxImages} images per reply.`);
            return;
        }
        const accepted = valid.slice(0, room);
        if (accepted.length < valid.length) {
            onNotice(`Only ${room} more image${room === 1 ? "" : "s"} fit — at most ${maxImages} per reply.`);
        }

        root.focus();
        for (const file of accepted) {
            const previewUrl = URL.createObjectURL(file);
            previewUrlsRef.current.add(previewUrl);
            const image = document.createElement("img");
            image.src = previewUrl;
            image.alt = file.name || "image";
            image.setAttribute("data-uploading", "1");
            insertNodeAtCaret(root, image);
            uploadingRef.current += 1;
            emit();

            uploadImage(file)
                .then((result) => {
                    if (!result?.url) {
                        image.remove();
                        return;
                    }
                    image.src = result.url;
                    image.removeAttribute("data-uploading");
                    image.addEventListener("load", updateHandleBox, { once: true });
                })
                .catch(() => {
                    image.remove();
                })
                .finally(() => {
                    URL.revokeObjectURL(previewUrl);
                    previewUrlsRef.current.delete(previewUrl);
                    uploadingRef.current -= 1;
                    emit();
                });
        }
    }, [acceptedMimeTypes, disabled, emit, maxImages, onNotice, updateHandleBox, uploadImage]);

    const clear = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        selectImage(null);
        root.innerHTML = "";
        previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        previewUrlsRef.current.clear();
        uploadingRef.current = 0;
        emit();
    }, [emit, selectImage]);

    useImperativeHandle(ref, () => ({
        insertImages,
        clear,
        focus: () => {
            const root = rootRef.current;
            if (!root) return;
            root.focus();
            placeCaretAtEnd(root);
        },
        getHtml: () => {
            const root = rootRef.current;
            if (!root) return "";
            linkifyTextNodes(root, true);
            root.querySelectorAll("img[data-selected]").forEach((image) => image.removeAttribute("data-selected"));
            const html = root.innerHTML;
            selectedImage?.setAttribute("data-selected", "1");
            return html;
        },
    }), [clear, insertImages, selectedImage]);

    // New lines as <p>, matching the review-page editor and the outgoing HTML.
    useEffect(() => {
        try {
            document.execCommand("defaultParagraphSeparator", false, "p");
        } catch {
            // execCommand may be unavailable in some environments
        }
    }, []);

    useEffect(() => () => {
        previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
        previewUrlsRef.current.clear();
    }, []);

    const handleInput = useCallback((event: FormEvent<HTMLDivElement>) => {
        const root = rootRef.current;
        if (!root) return;
        const native = event.nativeEvent as InputEvent;
        const finishedAWord = native.inputType === "insertParagraph"
            || native.inputType === "insertLineBreak"
            || (native.inputType === "insertText" && /\s/.test(native.data || ""));
        if (finishedAWord) linkifyTextNodes(root, false);
        emit();
    }, [emit]);

    const handleBlur = useCallback(() => {
        const root = rootRef.current;
        if (!root) return;
        linkifyTextNodes(root, true);
        if (!resizeRef.current) selectImage(null);
        emit();
    }, [emit, selectImage]);

    const handlePaste = useCallback((event: ClipboardEvent<HTMLDivElement>) => {
        const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
        if (files.length) {
            event.preventDefault();
            insertImages(files);
            return;
        }
        const text = event.clipboardData?.getData("text/plain");
        if (!text) return;
        // Plain text only — pasted rich content would drag foreign styles into the email.
        event.preventDefault();
        document.execCommand("insertHTML", false, plainTextToHtml(text));
        emit();
    }, [emit, insertImages]);

    const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
        setDragging(false);
        const files = Array.from(event.dataTransfer?.files || []).filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        event.preventDefault();
        const root = rootRef.current;
        const range = caretRangeFromPoint(event.clientX, event.clientY);
        if (root && range && root.contains(range.startContainer)) {
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
        insertImages(files);
    }, [insertImages]);

    const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
        if (disabled || !Array.from(event.dataTransfer?.types || []).includes("Files")) return;
        event.preventDefault();
        setDragging(true);
    }, [disabled]);

    // Links open on click (arrow keys move the caret into link text); an image
    // click selects it — outlined, resizable, and Backspace/Delete removes it.
    const handleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
        const root = rootRef.current;
        const target = event.target as HTMLElement;
        if (!root) return;
        if (target instanceof HTMLImageElement && root.contains(target)) {
            selectImage(target);
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNode(target);
            selection?.removeAllRanges();
            selection?.addRange(range);
            return;
        }
        selectImage(null);
        const anchor = target.closest?.("a[href]") as HTMLAnchorElement | null;
        if (!anchor || !root.contains(anchor)) return;
        event.preventDefault();
        window.open(anchor.href, "_blank", "noopener,noreferrer");
    }, [selectImage]);

    const handleResizeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
        const image = selectedImage;
        const root = rootRef.current;
        if (!image || !root || disabled) return;
        event.preventDefault();
        event.stopPropagation();
        const rootStyle = window.getComputedStyle(root);
        const maxWidth = root.clientWidth - parseFloat(rootStyle.paddingLeft) - parseFloat(rootStyle.paddingRight);
        resizeRef.current = { image, startX: event.clientX, startWidth: image.getBoundingClientRect().width, maxWidth };
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizeWidth(Math.round(resizeRef.current.startWidth));
    }, [disabled, selectedImage]);

    const handleResizeMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        const resize = resizeRef.current;
        if (!resize) return;
        const width = Math.round(Math.min(resize.maxWidth, Math.max(MIN_IMAGE_WIDTH, resize.startWidth + (event.clientX - resize.startX))));
        resize.image.setAttribute("width", String(width));
        setResizeWidth(width);
        updateHandleBox();
    }, [updateHandleBox]);

    const handleResizeEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!resizeRef.current) return;
        resizeRef.current = null;
        setResizeWidth(null);
        event.currentTarget.releasePointerCapture(event.pointerId);
        rootRef.current?.focus();
        updateHandleBox();
    }, [updateHandleBox]);

    const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
        if (onSubmit && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmit();
        }
    }, [onSubmit]);

    return (
        <div ref={frameRef} className="lead-reply-editor-frame">
            <div
                ref={rootRef}
                role="textbox"
                aria-multiline="true"
                aria-disabled={disabled ? "true" : undefined}
                aria-label={placeholder}
                data-placeholder={placeholder}
                className={`lead-reply-editor${dragging ? " lead-reply-editor--dragging" : ""}`}
                contentEditable={!disabled}
                suppressContentEditableWarning
                spellCheck
                onInput={handleInput}
                onBlur={handleBlur}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={() => setDragging(false)}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
            />
            {selectedImage && !disabled && (
                <>
                    {resizeWidth !== null && (
                        <span ref={sizeLabelRef} className="lead-reply-editor__size">
                            {resizeWidth}px
                        </span>
                    )}
                    <div
                        ref={handleRef}
                        role="slider"
                        aria-label="Resize image"
                        aria-valuenow={Math.round(selectedImage.getBoundingClientRect().width)}
                        className="lead-reply-editor__resize"
                        hidden
                        onPointerDown={handleResizeStart}
                        onPointerMove={handleResizeMove}
                        onPointerUp={handleResizeEnd}
                        onPointerCancel={handleResizeEnd}
                    />
                </>
            )}
        </div>
    );
});
