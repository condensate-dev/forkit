export interface ExploreServerOptions {
    /** The record directory (`.forkit`) whose runs to serve. */
    dir?: string;
    /** Run record files to serve besides (or instead of) `dir`'s runs. */
    files?: readonly string[];
    /** Port (default: a free one). */
    port?: number;
    /** Host to bind (default `127.0.0.1`). */
    host?: string;
}
export interface ExploreServer {
    /** `http://127.0.0.1:<port>/` */
    url: string;
    port: number;
    close(): Promise<void>;
}
/** A record file's run id, as the explorer serves it: its `id`, else its file name. */
export declare function fileRunId(file: string): string;
/** Serve the explorer. Resolves once it listens. */
export declare function startExploreServer(options?: ExploreServerOptions): Promise<ExploreServer>;
//# sourceMappingURL=server.d.ts.map