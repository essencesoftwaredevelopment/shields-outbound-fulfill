"use client";

import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function parseIsoDate(value: string): Date | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!match) return undefined;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? undefined : date;
}

function toIsoDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function parseTime(value: string): string {
    const match = /T(\d{2}):(\d{2})/.exec(value);
    if (!match) return "09:00";
    return `${match[1]}:${match[2]}`;
}

function formatDisplayDate(value: string, includeTime: boolean): string {
    const date = parseIsoDate(value);
    if (!date) return "";
    const dateLabel = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    if (!includeTime) return dateLabel;
    return `${dateLabel} ${parseTime(value)}`;
}

type DatePickerProps = {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    includeTime?: boolean;
    "aria-label"?: string;
};

export function DatePicker({
    value,
    onChange,
    placeholder = "Pick a date",
    disabled,
    className,
    includeTime = false,
    "aria-label": ariaLabel
}: DatePickerProps) {
    const [open, setOpen] = useState(false);
    const selected = value ? parseIsoDate(value) : undefined;
    const time = includeTime ? parseTime(value) : "09:00";

    const emit = (date: Date | undefined, nextTime = time) => {
        if (!date) {
            onChange("");
            return;
        }
        const isoDate = toIsoDate(date);
        onChange(includeTime ? `${isoDate}T${nextTime}` : isoDate);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={disabled}
                    aria-label={ariaLabel}
                    data-slot="date-picker-trigger"
                    className={cn(
                        "flex h-8 w-full min-w-[9.5rem] items-center justify-start gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm font-normal whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
                        !value && "text-muted-foreground",
                        className
                    )}
                >
                    <CalendarIcon className="size-3.5 text-muted-foreground" />
                    <span className="truncate">{value ? formatDisplayDate(value, includeTime) : placeholder}</span>
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-2">
                <Calendar
                    mode="single"
                    selected={selected}
                    onSelect={(date) => {
                        emit(date);
                        if (!includeTime) setOpen(false);
                    }}
                    defaultMonth={selected}
                />
                {includeTime ? (
                    <div className="flex items-center gap-2 border-t border-border pt-2">
                        <Input
                            type="time"
                            value={time}
                            disabled={!selected}
                            aria-label="Time"
                            className="h-8"
                            onChange={(event) => emit(selected, event.target.value || "09:00")}
                        />
                    </div>
                ) : null}
            </PopoverContent>
        </Popover>
    );
}
