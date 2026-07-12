"use client";

import { useState } from "react";
import type { MasterProfile } from "@/shared/schema";

// The identity block of the master-profile editor (§6). Links are capped at
// 4 by the schema; the add button disables at the cap. Validation copy is
// touched-gated (shown on blur — review F14); the Save-row line remains the
// always-on on-Save surface.

type Identity = MasterProfile["identity"];

export function IdentityFields(props: {
  identity: Identity;
  errors: Record<string, string>;
  onPatch(patch: Partial<Identity>): void;
}) {
  const { identity, errors } = props;
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => setTouched((prev) => new Set(prev).add(key));

  const text = (key: "name" | "email" | "phone" | "location", label: string) => (
    <label className="entry-field">
      <span className="entry-label">{label}</span>
      <input
        value={identity[key] ?? ""}
        onBlur={() => touch(key)}
        onChange={(e) =>
          props.onPatch({
            [key]: e.target.value === "" && key !== "name" ? undefined : e.target.value,
          })
        }
      />
      {touched.has(key) && errors[`identity.${key}`] && (
        <span className="input-error">
          {label} — {errors[`identity.${key}`]}
        </span>
      )}
    </label>
  );

  const patchLink = (i: number, patch: Partial<Identity["links"][number]>) => {
    const links = identity.links.map((link, li) => (li === i ? { ...link, ...patch } : link));
    props.onPatch({ links });
  };

  return (
    <div className="card entry-card">
      <span className="entry-label identity-title">Identity</span>
      {text("name", "Name")}
      {text("email", "Email")}
      {text("phone", "Phone")}
      {text("location", "Location")}

      <span className="entry-label">Links ({identity.links.length}/4)</span>
      {identity.links.map((link, i) => (
        <div key={i} className="identity-link-row">
          <input
            aria-label={`Link ${i + 1} label`}
            placeholder="Label (e.g. GitHub)"
            value={link.label}
            onBlur={() => touch(`links.${i}`)}
            onChange={(e) => patchLink(i, { label: e.target.value })}
          />
          <input
            aria-label={`Link ${i + 1} URL`}
            placeholder="https://…"
            value={link.url}
            onBlur={() => touch(`links.${i}`)}
            onChange={(e) => patchLink(i, { url: e.target.value })}
          />
          <button
            type="button"
            className="entry-action entry-delete"
            onClick={() => props.onPatch({ links: identity.links.filter((_, li) => li !== i) })}
            aria-label={`Remove link ${i + 1}`}
          >
            ×
          </button>
          {touched.has(`links.${i}`) &&
            (errors[`identity.links.${i}.label`] ?? errors[`identity.links.${i}.url`]) && (
              <span className="input-error">
                link — {errors[`identity.links.${i}.label`] ?? errors[`identity.links.${i}.url`]}
              </span>
            )}
        </div>
      ))}
      <button
        type="button"
        className="ghost-button entry-add-bullet"
        disabled={identity.links.length >= 4}
        onClick={() => props.onPatch({ links: [...identity.links, { label: "", url: "" }] })}
      >
        Add link
      </button>
    </div>
  );
}
