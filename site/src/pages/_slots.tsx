import "../components/home.css";
import { asset, BASE } from "../base.ts";

/** Vocs layout slots: the footer on every page. */
export function Footer() {
  return (
    <div className="fk-footer">
      <span>
        forkit, by{" "}
        <a href="https://condensate.dev" rel="noopener">
          Condensate
        </a>
      </span>
      <span className="fk-footer-links">
        <a href="https://github.com/condensate-dev/forkit">GitHub</a>
        <span aria-hidden="true">·</span>
        <a href={`${BASE}/docs/changelog`}>Changelog</a>
        <span aria-hidden="true">·</span>
        <a href={asset("THIRD_PARTY_NOTICES.txt")}>Third-party notices</a>
      </span>
    </div>
  );
}
