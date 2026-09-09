"use client";

import { useState } from "react";
import { EllipsisVertical } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type LeadToolbarMoreItem = {
    id: string;
    label: string;
    onSelect: () => void;
    disabled?: boolean;
};

export function LeadToolbarMoreMenu({ items }: { items: LeadToolbarMoreItem[] }) {
    const [open, setOpen] = useState(false);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className="lead-toolbar-more"
                    aria-label="More actions"
                    aria-haspopup="menu"
                    aria-expanded={open}
                >
                    <EllipsisVertical strokeWidth={2} />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="lead-toolbar-more-menu w-[17.5rem] min-w-[17.5rem] gap-0 p-1">
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="menuitem"
                        className="lead-toolbar-more-menu__item"
                        disabled={item.disabled}
                        onClick={() => {
                            if (item.disabled) return;
                            setOpen(false);
                            item.onSelect();
                        }}
                    >
                        {item.label}
                    </button>
                ))}
            </PopoverContent>
        </Popover>
    );
}
