"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "radix-ui";

export type ConfirmOptions = {
    title: string;
    message?: ReactNode;
    /** Verb that names the action, e.g. "Delete client". Never "OK". */
    confirmLabel: string;
    cancelLabel?: string;
    /** Destructive actions get the solid red button and focus lands on Cancel. */
    tone?: "destructive" | "default";
};

/**
 * In-app replacement for window.confirm. Returns a promise-based `confirm`
 * and the dialog element to render once in the component tree.
 *
 *   const [confirm, confirmDialog] = useConfirm();
 *   if (!(await confirm({ title: "Delete job?", confirmLabel: "Delete job" }))) return;
 */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const resolverRef = useRef<((value: boolean) => void) | null>(null);
    // No Radix Trigger here, so remember what opened the dialog and return focus to it.
    const returnFocusRef = useRef<HTMLElement | null>(null);

    const settle = useCallback((value: boolean) => {
        resolverRef.current?.(value);
        resolverRef.current = null;
        setOptions(null);
    }, []);

    const confirm = useCallback((next: ConfirmOptions) => {
        // A second request while one is open cancels the first.
        resolverRef.current?.(false);
        returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOptions(next);
        return new Promise<boolean>((resolve) => {
            resolverRef.current = resolve;
        });
    }, []);

    const destructive = (options?.tone ?? "destructive") === "destructive";

    const dialog = (
        <AlertDialog.Root open={options !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
            <AlertDialog.Portal>
                <AlertDialog.Overlay className="confirm-dialog__overlay" />
                <AlertDialog.Content
                    className="confirm-dialog"
                    onCloseAutoFocus={(event) => {
                        const target = returnFocusRef.current;
                        returnFocusRef.current = null;
                        if (target?.isConnected) {
                            event.preventDefault();
                            target.focus();
                        }
                    }}
                >
                    <AlertDialog.Title className="confirm-dialog__title">{options?.title}</AlertDialog.Title>
                    {options?.message ? (
                        <AlertDialog.Description className="confirm-dialog__message">{options.message}</AlertDialog.Description>
                    ) : (
                        <AlertDialog.Description className="sr-only">{options?.title}</AlertDialog.Description>
                    )}
                    <div className="confirm-dialog__actions">
                        <AlertDialog.Cancel className="secondary-button" autoFocus={destructive}>
                            {options?.cancelLabel ?? "Cancel"}
                        </AlertDialog.Cancel>
                        <AlertDialog.Action
                            className={destructive ? "destructive-button destructive-button--solid" : "primary-button"}
                            autoFocus={!destructive}
                            onClick={() => settle(true)}
                        >
                            {options?.confirmLabel}
                        </AlertDialog.Action>
                    </div>
                </AlertDialog.Content>
            </AlertDialog.Portal>
        </AlertDialog.Root>
    );

    return [confirm, dialog];
}
