import { leadFilterCategory, propertyLeadFilterFields } from "@/lib/leads/filterFieldGroups";
import type { AppSelectGroup, AppSelectOption } from "@/components/app-select";

type GroupableField = {
    key: string;
    label: string;
    group?: string;
    groupLabel?: string;
};

export function leadFilterFieldSelectGroups(fields: GroupableField[]): AppSelectGroup[] {
    const groups = new Map<string, AppSelectOption[]>();
    for (const field of fields) {
        const label = field.groupLabel || field.group || "Fields";
        const list = groups.get(label) || [];
        list.push({ value: field.key, label: field.label });
        groups.set(label, list);
    }
    return Array.from(groups.entries()).map(([label, options]) => ({ label, options }));
}

export function propertyFieldSelectOptions(
    fields: { key: string; label: string; type?: string; group?: string }[],
    currentKey?: string
): AppSelectOption[] {
    return propertyLeadFilterFields(fields, currentKey).map((field) => ({
        value: field.key,
        label: field.label
    }));
}

export function clauseCategory(field?: { type?: string; key?: string } | null) {
    return leadFilterCategory(field);
}
