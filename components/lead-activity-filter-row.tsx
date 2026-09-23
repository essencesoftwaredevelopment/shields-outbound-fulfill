"use client";

import instantlyLogo from "@/app/assets/instantly.png";
import { AppMultiSelect, AppSelect } from "@/components/app-select";
import { DatePicker } from "@/components/date-picker";
import { propertyFieldSelectOptions } from "@/components/lead-filter-field-options";
import {
    activityEventSupportsWhere,
    activityFrequencyNeedsCount,
    defaultActivityWhereClause,
    defaultLeadActivityValue,
    DEFAULT_ACTIVITY_OP,
    fallbackActivityTimeframes,
    fallbackActivityUnits,
    parseLeadActivityValue,
    serializeLeadActivityValue,
    type LeadActivityTimeframe,
    type LeadActivityValue,
    type LeadActivityWhere
} from "@/lib/leads/activityFilter";
import {
    activityEventSelectGroups,
    isLeadActivityCategory,
    LEAD_FILTER_CATEGORY_ACTIVITY,
    LEAD_FILTER_CATEGORY_OPTIONS,
    leadFilterCategory,
    propertyLeadFilterFields
} from "@/lib/leads/filterFieldGroups";

type FilterOption = { value: string; label: string; source?: string; group?: string };
type FilterOperator = { key: string; label: string };
type FilterWhereDimension = {
    key: string;
    label: string;
    eventTypes?: string[];
    operators: FilterOperator[];
    options: FilterOption[];
};
type FilterField = {
    key: string;
    label: string;
    type: string;
    operators: FilterOperator[];
    options: FilterOption[];
    timeframes?: { key: string; label: string }[];
    units?: { key: string; label: string }[];
    group?: string;
    groupLabel?: string;
    whereDimensions?: FilterWhereDimension[];
};

type FilterClause = {
    id: string;
    field: string;
    op: string;
    value: string;
};

type LeadActivityFilterRowProps = {
    filter: FilterClause;
    fields: FilterField[];
    field: FilterField;
    onChange: (filterId: string, updates: Partial<FilterClause> & { value?: string; op?: string; field?: string }) => void;
    onRemove: (filterId: string) => void;
    /** Inserts a copy of this filter directly after it, joined with AND. */
    onDuplicate?: (filterId: string) => void;
};

function nextTimeframe(kind: string, previous: LeadActivityTimeframe): LeadActivityTimeframe {
    if (kind === "over_all_time") return { kind };
    if (kind === "after" || kind === "before") {
        return { kind, date: previous.date || previous.start || "" };
    }
    if (kind === "between") {
        return {
            kind,
            minAmount: previous.minAmount || 7,
            maxAmount: previous.maxAmount || previous.amount || 30,
            unit: previous.unit || "days"
        };
    }
    if (kind === "between_dates") {
        return { kind, start: previous.start || previous.date || "", end: previous.end || "" };
    }
    return {
        kind,
        amount: previous.amount || 30,
        unit: previous.unit || "days"
    };
}

function filterValueMode(field: FilterField | undefined, operatorKey: string): string | null {
    if (!field) return null;
    if (isLeadActivityCategory(field)) return "activity";
    const noValueOps = ["is_empty", "not_empty", "is_true", "is_false", "found_and_valid"];
    if (noValueOps.includes(operatorKey)) return null;
    if (operatorKey === "older_than_days") return "number";
    if (operatorKey === "between") return "between";
    if (operatorKey === "in" || operatorKey === "not_in") return "multi";
    return field.type;
}

const chipTriggerClass = "lead-activity-select-trigger";

export function LeadActivityFilterRow({
    filter,
    fields,
    field,
    onChange,
    onRemove,
    onDuplicate
}: LeadActivityFilterRowProps) {
    const category = leadFilterCategory(field);
    const activityField = fields.find((item) => isLeadActivityCategory(item)) || field;
    const propertyFields = propertyLeadFilterFields(fields, filter.field);
    const firstProperty = propertyFields[0];

    const parsed = parseLeadActivityValue(filter.value) || defaultLeadActivityValue(activityField.options[0]?.value);
    const selectedEvent = (activityField.options || []).find((option) => option.value === parsed.eventType);
    const showInstantlyMark = selectedEvent?.source !== "shields" && selectedEvent?.group !== "Shields Outbound";
    const timeframes = activityField.timeframes?.length ? activityField.timeframes : fallbackActivityTimeframes();
    const units = activityField.units?.length ? activityField.units : fallbackActivityUnits();
    const needsCount = activityFrequencyNeedsCount(filter.op);
    const timeframe = parsed.timeframe;
    const operators = field?.operators || [];
    const valueMode = filterValueMode(field, filter.op);
    const whereDimensions = (activityField.whereDimensions || []).filter((dimension) => (
        !dimension.eventTypes?.length || dimension.eventTypes.includes(parsed.eventType)
    ));
    const supportsWhere = activityEventSupportsWhere(parsed.eventType) && whereDimensions.length > 0;
    const whereClauses = supportsWhere ? (parsed.where || []) : [];

    const parsedArrayValue: string[] = (() => {
        try { return JSON.parse(filter.value || "[]"); } catch { return []; }
    })();

    const commitActivity = (next: Partial<LeadActivityValue> & { op?: string }) => {
        const op = next.op || filter.op;
        const eventType = next.eventType || parsed.eventType;
        const where = activityEventSupportsWhere(eventType)
            ? (next.where !== undefined ? next.where : parsed.where)
            : undefined;
        const value: LeadActivityValue = {
            eventType,
            timeframe: next.timeframe || parsed.timeframe,
            ...(activityFrequencyNeedsCount(op)
                ? { count: next.count != null ? next.count : (parsed.count ?? 1) }
                : {}),
            ...(where?.length ? { where } : {})
        };
        onChange(filter.id, { op, value: serializeLeadActivityValue(value) });
    };

    const updateWhereClause = (index: number, nextClause: LeadActivityWhere) => {
        const next = [...whereClauses];
        next[index] = nextClause;
        commitActivity({ where: next });
    };

    const removeWhereClause = (index: number) => {
        commitActivity({ where: whereClauses.filter((_, itemIndex) => itemIndex !== index) });
    };

    const addWhereClause = () => {
        const dimension = whereDimensions[0];
        commitActivity({
            where: [
                ...whereClauses,
                dimension
                    ? { dimension: dimension.key, op: dimension.operators[0]?.key || "eq", value: "" }
                    : defaultActivityWhereClause()
            ]
        });
    };

    const applyWhereOp = (index: number, op: string, clause: LeadActivityWhere) => {
        if (op === "in" || op === "not_in") {
            const values = Array.isArray(clause.value) ? clause.value : (clause.value ? [clause.value] : []);
            updateWhereClause(index, { ...clause, op, value: values });
            return;
        }
        const value = Array.isArray(clause.value) ? (clause.value[0] || "") : clause.value;
        updateWhereClause(index, { ...clause, op, value });
    };

    const applyCategory = (nextCategory: string) => {
        if (nextCategory === LEAD_FILTER_CATEGORY_ACTIVITY) {
            onChange(filter.id, {
                field: activityField.key,
                op: activityField.operators[0]?.key || DEFAULT_ACTIVITY_OP,
                value: serializeLeadActivityValue(defaultLeadActivityValue(activityField.options[0]?.value))
            });
            return;
        }
        if (!firstProperty) return;
        onChange(filter.id, {
            field: firstProperty.key,
            op: firstProperty.operators[0]?.key || "",
            value: ""
        });
    };

    const applyPropertyField = (nextFieldKey: string) => {
        const nextField = fields.find((item) => item.key === nextFieldKey) || firstProperty;
        if (!nextField) return;
        if (isLeadActivityCategory(nextField)) {
            applyCategory(LEAD_FILTER_CATEGORY_ACTIVITY);
            return;
        }
        onChange(filter.id, {
            field: nextField.key,
            op: nextField.operators[0]?.key || "",
            value: ""
        });
    };

    return (
        <div className="lead-activity-filter">
            <div className="lead-activity-filter__header">
                <AppSelect
                    value={category}
                    options={LEAD_FILTER_CATEGORY_OPTIONS}
                    triggerClassName={chipTriggerClass}
                    aria-label="Filter category"
                    onChange={applyCategory}
                />
                {onDuplicate && (
                    <button
                        type="button"
                        className="lead-activity-filter__icon-btn"
                        onClick={() => onDuplicate(filter.id)}
                        aria-label="Duplicate filter"
                        title="Duplicate filter (adds a copy joined with AND)"
                    >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.7"/>
                            <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
                        </svg>
                    </button>
                )}
                <button
                    type="button"
                    className="lead-activity-filter__icon-btn"
                    onClick={() => onRemove(filter.id)}
                    aria-label="Remove filter"
                    title="Remove filter"
                >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7h12Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
                    </svg>
                </button>
            </div>

            {category === LEAD_FILTER_CATEGORY_ACTIVITY ? (
                <>
                <div className="lead-activity-filter__clause">
                    {showInstantlyMark ? (
                        <img
                            className="lead-activity-filter__mark"
                            src={typeof instantlyLogo === "string" ? instantlyLogo : instantlyLogo.src}
                            alt=""
                        />
                    ) : null}
                    <div className="lead-activity-filter__name">
                        <AppSelect
                            value={parsed.eventType}
                            groups={activityEventSelectGroups(activityField.options || [])}
                            searchable
                            triggerClassName={chipTriggerClass}
                            aria-label="Activity"
                            onChange={(eventType) => commitActivity({ eventType })}
                        />
                    </div>
                    <span className="lead-activity-filter__prefix">Lead has</span>
                    <AppSelect
                        value={filter.op}
                        options={activityField.operators.map((operator) => ({ value: operator.key, label: operator.label }))}
                        triggerClassName={chipTriggerClass}
                        aria-label="How many times"
                        onChange={(op) => commitActivity({ op })}
                    />
                    {needsCount ? (
                        <input
                            className="lead-activity-chip lead-activity-chip--num"
                            type="number"
                            min={0}
                            value={parsed.count ?? 1}
                            onChange={(event) => commitActivity({ count: Number(event.target.value) })}
                            aria-label="Times"
                        />
                    ) : null}
                    <AppSelect
                        value={timeframe.kind}
                        options={timeframes.map((item) => ({ value: item.key, label: item.label }))}
                        triggerClassName={chipTriggerClass}
                        aria-label="Timeframe"
                        onChange={(kind) => commitActivity({ timeframe: nextTimeframe(kind, timeframe) })}
                    />
                    {timeframe.kind === "in_the_last" || timeframe.kind === "at_least" ? (
                        <>
                            <input
                                className="lead-activity-chip lead-activity-chip--num"
                                type="number"
                                min={1}
                                value={timeframe.amount ?? 30}
                                onChange={(event) => commitActivity({
                                    timeframe: { ...timeframe, amount: Number(event.target.value) }
                                })}
                                aria-label="Time amount"
                            />
                            <AppSelect
                                value={timeframe.unit || "days"}
                                options={units.map((item) => ({ value: item.key, label: item.label }))}
                                triggerClassName={chipTriggerClass}
                                aria-label="Time unit"
                                onChange={(unit) => commitActivity({ timeframe: { ...timeframe, unit } })}
                            />
                        </>
                    ) : null}
                    {timeframe.kind === "after" || timeframe.kind === "before" ? (
                        <DatePicker
                            value={timeframe.date || ""}
                            onChange={(date) => commitActivity({ timeframe: { ...timeframe, date } })}
                            aria-label="Date"
                            className="lead-activity-date-trigger"
                        />
                    ) : null}
                    {timeframe.kind === "between" ? (
                        <>
                            <input
                                className="lead-activity-chip lead-activity-chip--num"
                                type="number"
                                min={1}
                                value={timeframe.minAmount ?? 7}
                                onChange={(event) => commitActivity({
                                    timeframe: { ...timeframe, minAmount: Number(event.target.value) }
                                })}
                                aria-label="From"
                            />
                            <span className="lead-activity-filter__prefix">and</span>
                            <input
                                className="lead-activity-chip lead-activity-chip--num"
                                type="number"
                                min={1}
                                value={timeframe.maxAmount ?? 30}
                                onChange={(event) => commitActivity({
                                    timeframe: { ...timeframe, maxAmount: Number(event.target.value) }
                                })}
                                aria-label="To"
                            />
                            <AppSelect
                                value={timeframe.unit || "days"}
                                options={units.map((item) => ({ value: item.key, label: item.label }))}
                                triggerClassName={chipTriggerClass}
                                aria-label="Time unit"
                                onChange={(unit) => commitActivity({ timeframe: { ...timeframe, unit } })}
                            />
                        </>
                    ) : null}
                    {timeframe.kind === "between_dates" ? (
                        <>
                            <DatePicker
                                value={timeframe.start || ""}
                                onChange={(start) => commitActivity({ timeframe: { ...timeframe, start } })}
                                aria-label="Start date"
                                className="lead-activity-date-trigger"
                            />
                            <span className="lead-activity-filter__prefix">and</span>
                            <DatePicker
                                value={timeframe.end || ""}
                                onChange={(end) => commitActivity({ timeframe: { ...timeframe, end } })}
                                aria-label="End date"
                                className="lead-activity-date-trigger"
                            />
                        </>
                    ) : null}
                </div>
                {whereClauses.map((clause, index) => {
                    const dimension = whereDimensions.find((item) => item.key === clause.dimension) || whereDimensions[0];
                    const multi = clause.op === "in" || clause.op === "not_in";
                    const selectedValues = Array.isArray(clause.value)
                        ? clause.value
                        : (clause.value ? [clause.value] : []);
                    return (
                        <div key={`where-${index}`} className="lead-activity-filter__clause lead-activity-filter__clause--where">
                            <span className="lead-activity-filter__where-label">WHERE</span>
                            <AppSelect
                                value={clause.dimension}
                                options={whereDimensions.map((item) => ({ value: item.key, label: item.label }))}
                                triggerClassName={chipTriggerClass}
                                aria-label="Where dimension"
                                onChange={(dimensionKey) => {
                                    const nextDimension = whereDimensions.find((item) => item.key === dimensionKey) || dimension;
                                    updateWhereClause(index, {
                                        dimension: nextDimension.key,
                                        op: nextDimension.operators[0]?.key || "eq",
                                        value: ""
                                    });
                                }}
                            />
                            <AppSelect
                                value={clause.op}
                                options={(dimension?.operators || []).map((operator) => ({
                                    value: operator.key,
                                    label: operator.label
                                }))}
                                triggerClassName={chipTriggerClass}
                                aria-label="Where operator"
                                onChange={(op) => applyWhereOp(index, op, clause)}
                            />
                            {multi ? (
                                <AppMultiSelect
                                    values={selectedValues}
                                    options={(dimension?.options || []).map((option) => ({
                                        value: option.value,
                                        label: option.label
                                    }))}
                                    triggerClassName={chipTriggerClass}
                                    aria-label="Campaigns"
                                    onChange={(values) => updateWhereClause(index, { ...clause, value: values })}
                                />
                            ) : (
                                <div className="lead-activity-filter__name">
                                    <AppSelect
                                        value={typeof clause.value === "string" ? clause.value : selectedValues[0] || ""}
                                        placeholder="Select campaign"
                                        emptyLabel="Select campaign"
                                        options={(dimension?.options || []).map((option) => ({
                                            value: option.value,
                                            label: option.label
                                        }))}
                                        searchable
                                        triggerClassName={chipTriggerClass}
                                        aria-label="Campaign"
                                        onChange={(value) => updateWhereClause(index, { ...clause, value })}
                                    />
                                </div>
                            )}
                            <button
                                type="button"
                                className="lead-activity-filter__icon-btn"
                                onClick={() => removeWhereClause(index)}
                                aria-label="Remove where filter"
                            >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7h12Z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
                                    <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
                                </svg>
                            </button>
                        </div>
                    );
                })}
                {supportsWhere && whereClauses.length === 0 ? (
                    <button
                        type="button"
                        className="lead-activity-filter__where-add"
                        onClick={addWhereClause}
                    >
                        WHERE
                    </button>
                ) : null}
            </>
            ) : (
                <div className="lead-activity-filter__clause">
                    <div className="lead-activity-filter__name">
                        <AppSelect
                            value={filter.field}
                            options={propertyFieldSelectOptions(fields, filter.field)}
                            searchable
                            triggerClassName={chipTriggerClass}
                            aria-label="Property"
                            onChange={applyPropertyField}
                        />
                    </div>
                    <AppSelect
                        value={filter.op}
                        options={operators.map((operator) => ({ value: operator.key, label: operator.label }))}
                        triggerClassName={chipTriggerClass}
                        aria-label="Operator"
                        onChange={(nextOp) => {
                            const noValueOps = ["is_empty", "not_empty", "is_true", "is_false", "found_and_valid"];
                            onChange(filter.id, {
                                op: nextOp,
                                value: noValueOps.includes(nextOp) ? "" : filter.value
                            });
                        }}
                    />
                    {!valueMode ? (
                        <span className="lead-activity-filter__prefix">No value needed</span>
                    ) : valueMode === "enum" ? (
                        <AppSelect
                            value={filter.value}
                            placeholder="Select value"
                            emptyLabel="Select value"
                            options={(field?.options || []).map((option) => ({ value: option.value, label: option.label }))}
                            triggerClassName={chipTriggerClass}
                            onChange={(value) => onChange(filter.id, { value })}
                        />
                    ) : valueMode === "multi" ? (
                        <AppMultiSelect
                            values={parsedArrayValue}
                            options={(field?.options || []).map((option) => ({ value: option.value, label: option.label }))}
                            triggerClassName={chipTriggerClass}
                            onChange={(arr) => onChange(filter.id, { value: JSON.stringify(arr) })}
                        />
                    ) : valueMode === "between" ? (
                        <>
                            <DatePicker
                                value={parsedArrayValue[0] || ""}
                                onChange={(value) => onChange(filter.id, { value: JSON.stringify([value, parsedArrayValue[1] || ""]) })}
                                aria-label="From date"
                                className="lead-activity-date-trigger"
                            />
                            <span className="lead-activity-filter__prefix">to</span>
                            <DatePicker
                                value={parsedArrayValue[1] || ""}
                                onChange={(value) => onChange(filter.id, { value: JSON.stringify([parsedArrayValue[0] || "", value]) })}
                                aria-label="To date"
                                className="lead-activity-date-trigger"
                            />
                        </>
                    ) : valueMode === "date" ? (
                        <DatePicker
                            value={filter.value}
                            onChange={(value) => onChange(filter.id, { value })}
                            className="lead-activity-date-trigger"
                        />
                    ) : (
                        <input
                            className="lead-activity-chip"
                            type={valueMode === "number" ? "number" : "text"}
                            value={filter.value}
                            onChange={(event) => onChange(filter.id, { value: event.target.value })}
                            placeholder={valueMode === "number" ? "Enter number" : "Enter value"}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
