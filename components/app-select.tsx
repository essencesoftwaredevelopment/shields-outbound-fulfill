"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type AppSelectOption = {
    value: string;
    label: string;
    disabled?: boolean;
    source?: string;
    group?: string;
};

export type AppSelectGroup = {
    label: string;
    options: AppSelectOption[];
};

const SEARCH_THRESHOLD = 8;

type ListedOption = AppSelectOption & { group?: string };

type AppSelectProps = {
    value: string;
    onChange: (value: string) => void;
    options?: AppSelectOption[];
    groups?: AppSelectGroup[];
    placeholder?: string;
    emptyLabel?: string;
    searchable?: boolean;
    disabled?: boolean;
    className?: string;
    triggerClassName?: string;
    size?: "sm" | "default";
    "aria-label"?: string;
    onOpenChange?: (open: boolean) => void;
};

function collectOptions(
    options: AppSelectOption[],
    groups: AppSelectGroup[] | undefined,
    emptyLabel?: string
): ListedOption[] {
    const listed: ListedOption[] = [];
    if (emptyLabel) listed.push({ value: "", label: emptyLabel });
    for (const group of groups || []) {
        for (const option of group.options) {
            listed.push({ ...option, group: group.label });
        }
    }
    for (const option of options) {
        if (option.value === "" && emptyLabel) continue;
        listed.push(option);
    }
    return listed;
}

function optionMatches(option: ListedOption, query: string) {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return option.label.toLowerCase().includes(needle)
        || option.value.toLowerCase().includes(needle)
        || (option.group || "").toLowerCase().includes(needle);
}

const triggerClass = "flex w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-placeholder:text-muted-foreground data-[size=default]:h-8 data-[size=sm]:h-7 data-[size=sm]:rounded-[min(var(--radius-md),10px)] dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4";

function SelectSearch({
    query,
    onQueryChange,
    onKeyDown,
    inputRef
}: {
    query: string;
    onQueryChange: (query: string) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    inputRef: React.RefObject<HTMLInputElement | null>;
}) {
    return (
        <div className="sticky top-0 z-10 bg-popover p-1">
            <div className="relative">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={inputRef}
                    value={query}
                    placeholder="Search…"
                    aria-label="Search options"
                    autoComplete="off"
                    className="h-8 pl-7"
                    onChange={(event) => onQueryChange(event.target.value)}
                    onKeyDown={onKeyDown}
                />
            </div>
        </div>
    );
}

export function AppSelect({
    value,
    onChange,
    options = [],
    groups,
    placeholder,
    emptyLabel,
    searchable: searchableProp,
    disabled,
    className,
    triggerClassName,
    size = "default",
    "aria-label": ariaLabel,
    onOpenChange
}: AppSelectProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const highlightedRef = useRef<HTMLButtonElement>(null);

    const listed = useMemo(
        () => collectOptions(options, groups, emptyLabel),
        [options, groups, emptyLabel]
    );
    const searchable = searchableProp ?? listed.length > SEARCH_THRESHOLD;
    const visible = useMemo(
        () => (searchable ? listed.filter((option) => optionMatches(option, query)) : listed),
        [listed, query, searchable]
    );

    const selected = listed.find((option) => option.value === value);
    const displayLabel = selected?.label || (value ? value : placeholder) || "";
    const showPlaceholder = !selected && !value;

    useEffect(() => {
        if (highlightedIndex >= visible.length) setHighlightedIndex(0);
    }, [highlightedIndex, visible.length]);

    useEffect(() => {
        highlightedRef.current?.scrollIntoView({ block: "nearest" });
    }, [highlightedIndex, visible]);

    const handleOpenChange = (next: boolean) => {
        setOpen(next);
        if (next) {
            setQuery("");
            const selectedIndex = listed.findIndex((option) => option.value === value);
            setHighlightedIndex(selectedIndex >= 0 ? selectedIndex : 0);
        } else {
            setQuery("");
        }
        onOpenChange?.(next);
    };

    const choose = (next: string) => {
        onChange(next);
        handleOpenChange(false);
    };

    const moveHighlight = (delta: number) => {
        if (visible.length === 0) return;
        setHighlightedIndex((current) => {
            const next = current + delta;
            if (next < 0) return visible.length - 1;
            if (next >= visible.length) return 0;
            return next;
        });
    };

    const handleListKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            moveHighlight(1);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            moveHighlight(-1);
        } else if (event.key === "Home") {
            event.preventDefault();
            setHighlightedIndex(0);
        } else if (event.key === "End") {
            event.preventDefault();
            setHighlightedIndex(Math.max(visible.length - 1, 0));
        } else if (event.key === "Enter") {
            event.preventDefault();
            const option = visible[highlightedIndex];
            if (option && !option.disabled) choose(option.value);
        }
    };

    return (
        <Popover open={open} onOpenChange={handleOpenChange}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    data-slot="select-trigger"
                    data-size={size}
                    disabled={disabled}
                    aria-label={ariaLabel}
                    aria-expanded={open}
                    aria-haspopup="listbox"
                    className={cn(triggerClass, triggerClassName)}
                >
                    <span
                        data-slot="select-value"
                        className={cn("min-w-0 flex-1 truncate text-left", showPlaceholder && "text-muted-foreground")}
                    >
                        {displayLabel}
                    </span>
                    <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className={cn(
                    "w-[var(--radix-popover-trigger-width)] gap-0 p-1",
                    searchable ? "min-w-72" : "min-w-48",
                    className
                )}
                onOpenAutoFocus={(event) => {
                    if (searchable) {
                        event.preventDefault();
                        inputRef.current?.focus();
                    }
                }}
                onKeyDown={searchable ? undefined : handleListKeyDown}
            >
                {searchable ? (
                    <SelectSearch
                        query={query}
                        onQueryChange={(next) => {
                            setQuery(next);
                            setHighlightedIndex(0);
                        }}
                        onKeyDown={handleListKeyDown}
                        inputRef={inputRef}
                    />
                ) : null}
                <div role="listbox" aria-label={ariaLabel} className="max-h-56 overflow-y-auto p-0.5">
                    {visible.length === 0 ? (
                        <div className="px-2 py-2 text-sm text-muted-foreground">No matches</div>
                    ) : visible.map((option, index) => {
                        const showGroup = Boolean(option.group) && option.group !== visible[index - 1]?.group;
                        const active = index === highlightedIndex;
                        const checked = option.value === value;
                        return (
                            <div key={`${option.group || ""}:${option.value || "__empty__"}`}>
                                {showGroup ? (
                                    <div className="px-1.5 py-1 text-xs text-muted-foreground">{option.group}</div>
                                ) : null}
                                <button
                                    ref={active ? highlightedRef : undefined}
                                    type="button"
                                    role="option"
                                    aria-selected={checked}
                                    disabled={option.disabled}
                                    className={cn(
                                        "relative flex w-full cursor-default items-center rounded-md py-1.5 pr-8 pl-1.5 text-left text-sm outline-hidden select-none",
                                        active && "bg-accent text-accent-foreground",
                                        option.disabled && "pointer-events-none opacity-50"
                                    )}
                                    onMouseEnter={() => setHighlightedIndex(index)}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => choose(option.value)}
                                >
                                    {option.label}
                                    {checked ? (
                                        <CheckIcon className="absolute right-2 size-4" />
                                    ) : null}
                                </button>
                            </div>
                        );
                    })}
                </div>
            </PopoverContent>
        </Popover>
    );
}

type AppMultiSelectProps = {
    values: string[];
    onChange: (values: string[]) => void;
    options: AppSelectOption[];
    placeholder?: string;
    disabled?: boolean;
    triggerClassName?: string;
    "aria-label"?: string;
};

export function AppMultiSelect({
    values,
    onChange,
    options,
    placeholder = "Select values",
    disabled,
    triggerClassName,
    "aria-label": ariaLabel
}: AppMultiSelectProps) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);
    const searchable = options.length > SEARCH_THRESHOLD;
    const visible = useMemo(
        () => (searchable ? options.filter((option) => optionMatches(option, query)) : options),
        [options, query, searchable]
    );
    const selected = new Set(values);
    const label = values.length === 0
        ? placeholder
        : values.length === 1
            ? (options.find((option) => option.value === values[0])?.label || values[0])
            : `${values.length} selected`;

    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) setQuery("");
            }}
        >
            <PopoverTrigger asChild>
                <Button
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    aria-label={ariaLabel}
                    data-slot="select-trigger"
                    className={cn("h-8 w-full min-w-0 justify-between font-normal", triggerClassName)}
                >
                    <span className="truncate">{label}</span>
                    <ChevronDownIcon className="size-4 text-muted-foreground" />
                </Button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] min-w-48 gap-0 p-1"
                onOpenAutoFocus={(event) => {
                    if (searchable) {
                        event.preventDefault();
                        inputRef.current?.focus();
                    }
                }}
            >
                {searchable ? (
                    <SelectSearch
                        query={query}
                        onQueryChange={setQuery}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") event.preventDefault();
                        }}
                        inputRef={inputRef}
                    />
                ) : null}
                <div className="max-h-56 overflow-y-auto">
                    {visible.length === 0 ? (
                        <div className="px-2 py-2 text-sm text-muted-foreground">No matches</div>
                    ) : visible.map((option) => {
                        const checked = selected.has(option.value);
                        return (
                            <button
                                key={option.value}
                                type="button"
                                disabled={option.disabled}
                                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                                onClick={() => {
                                    if (checked) onChange(values.filter((item) => item !== option.value));
                                    else onChange([...values, option.value]);
                                }}
                            >
                                <span className={cn(
                                    "flex size-3.5 items-center justify-center rounded-sm border border-input",
                                    checked && "border-primary bg-primary text-primary-foreground"
                                )}>
                                    {checked ? <CheckIcon className="size-3" /> : null}
                                </span>
                                {option.label}
                            </button>
                        );
                    })}
                </div>
            </PopoverContent>
        </Popover>
    );
}
