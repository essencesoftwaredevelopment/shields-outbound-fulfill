const LEAD_ACTIVITY_FIELD_KEY = "lead_activity";

type SelectOption = { value: string; label: string; source?: string; group?: string };
type SelectGroup = { label: string; options: SelectOption[] };

export const LEAD_FILTER_CATEGORY_ACTIVITY = "activity";
export const LEAD_FILTER_CATEGORY_PROPERTY = "property";

export const LEAD_FILTER_CATEGORY_OPTIONS = [
    { value: LEAD_FILTER_CATEGORY_ACTIVITY, label: "What someone has done (or not done)" },
    { value: LEAD_FILTER_CATEGORY_PROPERTY, label: "Properties about someone" }
];

type FilterishField = {
    key: string;
    label: string;
    type?: string;
    group?: string;
};

export function isLeadActivityCategory(field?: { type?: string; key?: string } | null) {
    return field?.type === "activity" || field?.key === LEAD_ACTIVITY_FIELD_KEY;
}

export function leadFilterCategory(field?: { type?: string; key?: string } | null) {
    return isLeadActivityCategory(field)
        ? LEAD_FILTER_CATEGORY_ACTIVITY
        : LEAD_FILTER_CATEGORY_PROPERTY;
}

export function propertyLeadFilterFields<T extends FilterishField>(fields: T[], currentKey?: string): T[] {
    return fields.filter((field) => {
        if (isLeadActivityCategory(field)) return false;
        if (field.group === LEAD_FILTER_CATEGORY_ACTIVITY) {
            return Boolean(currentKey) && field.key === currentKey;
        }
        return true;
    });
}

export function singleListIdFromLeadFilters(
    filters: Array<{ field: string; op: string; value: string }>
): string {
    const matches = filters.filter((filter) => filter.field === "list");
    if (matches.length !== 1) return "";
    const filter = matches[0];
    if (filter.op === "eq") {
        const id = String(filter.value || "").trim();
        return /^\d+$/.test(id) ? id : "";
    }
    if (filter.op === "in") {
        try {
            const parsed = JSON.parse(filter.value);
            if (Array.isArray(parsed) && parsed.length === 1) {
                const id = String(parsed[0] || "").trim();
                return /^\d+$/.test(id) ? id : "";
            }
        } catch {
            return "";
        }
    }
    return "";
}

export function activityEventSelectGroups(options: SelectOption[]): SelectGroup[] {
    const instantly: SelectOption[] = [];
    const shields: SelectOption[] = [];
    for (const option of options) {
        if (option.source === "shields" || option.group === "Shields Outbound") {
            shields.push(option);
        } else {
            instantly.push(option);
        }
    }
    return [
        ...(instantly.length ? [{ label: "Instantly", options: instantly }] : []),
        ...(shields.length ? [{ label: "Shields Outbound", options: shields }] : [])
    ];
}
