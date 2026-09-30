"use client";

import { useState } from "react";

const MANAGERS = [
  { id: "npm", command: "npm i -D @condensate/forkit viem" },
  { id: "pnpm", command: "pnpm add -D @condensate/forkit viem" },
  { id: "bun", command: "bun add -d @condensate/forkit viem" },
] as const;

/** npm / pnpm / bun install box with a copy button, in the Vocs home-page style. */
export function InstallTabs() {
  const [active, setActive] = useState<(typeof MANAGERS)[number]["id"]>("npm");
  const [copied, setCopied] = useState(false);
  const command = MANAGERS.find((m) => m.id === active)?.command ?? "";
  return (
    <div className="fk-install">
      <div className="fk-install-tabs" role="tablist" aria-label="Package manager">
        {MANAGERS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={m.id === active}
            className="fk-install-tab"
            onClick={() => {
              setActive(m.id);
              setCopied(false);
            }}
          >
            {m.id}
          </button>
        ))}
      </div>
      <div className="fk-install-command">
        <code>
          <span className="fk-install-prompt" aria-hidden="true">
            ${" "}
          </span>
          {command}
        </code>
        <button
          type="button"
          className="fk-install-copy"
          aria-label={copied ? "Copied" : "Copy install command"}
          onClick={async () => {
            await navigator.clipboard.writeText(command);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
