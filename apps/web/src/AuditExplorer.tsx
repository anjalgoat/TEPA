import { useMemo, useState } from "react";
import type { AuditEvent } from "./api.js";

function utc(value: string) {
    return `${new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

function label(value: string) {
    return value.replaceAll("_", " ").toLowerCase();
}

export function AuditExplorer({ events }: { events: AuditEvent[] }) {
    const [resource, setResource] = useState("all");
    const [query, setQuery] = useState("");
    const resources = useMemo(() => [...new Set(events.map((event) => event.resourceType))].sort(), [events]);
    const matching = useMemo(() => {
        const term = query.trim().toLowerCase();
        return events.filter(
            (event) =>
                (resource === "all" || event.resourceType === resource) &&
                (!term ||
                    [event.action, event.actorRef, event.resourceId, event.reason, event.sourceVersion]
                        .join(" ")
                        .toLowerCase()
                        .includes(term)),
        );
    }, [events, resource, query]);

    return (
        <section className="audit audit-explorer" aria-labelledby="audit-heading">
            <p className="section-index">08 / Audit explorer</p>
            <h2 id="audit-heading">Recorded decisions and chain steps</h2>
            <p>
                Each row is an append-only application event. Source and calculation references can be
                compared with the other workflow views. A chain command records an instruction; settlement
                needs a confirmed receipt in the holder record.
            </p>
            {events.length === 0 ? (
                <p role="status">No actions have been recorded yet.</p>
            ) : (
                <>
                    <div className="audit-filters">
                        <label>
                            Record type
                            <select value={resource} onChange={(event) => setResource(event.target.value)}>
                                <option value="all">All record types</option>
                                {resources.map((value) => (
                                    <option key={value} value={value}>
                                        {label(value)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            Find action, actor, reason, or resource ID
                            <input
                                type="search"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                            />
                        </label>
                    </div>
                    <p className="audit-count" role="status">
                        {matching.length} of {events.length} recent events shown. This view includes up to the
                        latest 200 events.
                    </p>
                    {matching.length === 0 ? (
                        <p>No events match those filters.</p>
                    ) : (
                        <ol>
                            {matching.map((event) => (
                                <li key={event.id}>
                                    <details>
                                        <summary>
                                            <strong>{label(event.action)}</strong>
                                            <span>
                                                {label(event.resourceType)} · {event.actorRef} ·{" "}
                                                {utc(event.occurredAt)}
                                            </span>
                                        </summary>
                                        <p>{event.reason}</p>
                                        <dl className="audit-details">
                                            <div>
                                                <dt>Resource</dt>
                                                <dd>
                                                    <code>{event.resourceId}</code>
                                                </dd>
                                            </div>
                                            <div>
                                                <dt>Source version</dt>
                                                <dd>{event.sourceVersion}</dd>
                                            </div>
                                            {event.formulaVersion && (
                                                <div>
                                                    <dt>Formula</dt>
                                                    <dd>{event.formulaVersion}</dd>
                                                </div>
                                            )}
                                            {event.policyVersion && (
                                                <div>
                                                    <dt>Policy</dt>
                                                    <dd>{event.policyVersion}</dd>
                                                </div>
                                            )}
                                            {event.termsVersion && (
                                                <div>
                                                    <dt>Terms</dt>
                                                    <dd>{event.termsVersion}</dd>
                                                </div>
                                            )}
                                            {event.approvalId && (
                                                <div>
                                                    <dt>Approval ID</dt>
                                                    <dd>
                                                        <code>{event.approvalId}</code>
                                                    </dd>
                                                </div>
                                            )}
                                            {event.beforeHash && (
                                                <div>
                                                    <dt>Before SHA-256</dt>
                                                    <dd>
                                                        <code>{event.beforeHash}</code>
                                                    </dd>
                                                </div>
                                            )}
                                            {event.afterHash && (
                                                <div>
                                                    <dt>After SHA-256</dt>
                                                    <dd>
                                                        <code>{event.afterHash}</code>
                                                    </dd>
                                                </div>
                                            )}
                                            {event.chainCommandId && (
                                                <div>
                                                    <dt>Chain command ID</dt>
                                                    <dd>
                                                        <code>{event.chainCommandId}</code>
                                                    </dd>
                                                </div>
                                            )}
                                            {event.chainEventId && (
                                                <div>
                                                    <dt>Chain event ID</dt>
                                                    <dd>
                                                        <code>{event.chainEventId}</code>
                                                    </dd>
                                                </div>
                                            )}
                                        </dl>
                                    </details>
                                </li>
                            ))}
                        </ol>
                    )}
                </>
            )}
        </section>
    );
}
