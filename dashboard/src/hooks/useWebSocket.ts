"use client";

import { useEffect, useRef } from "react";
import { wsUrl } from "@/lib/api";
import type { WSEvent } from "@/lib/types";

export function useWebSocket(onEvent: (e: WSEvent) => void) {
  const cb = useRef(onEvent);
  cb.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(wsUrl());
      ws.onmessage = (e) => {
        try { cb.current(JSON.parse(e.data as string)); } catch { /* ignore malformed */ }
      };
      ws.onclose = () => { timer = setTimeout(connect, 3000); };
    }

    connect();
    return () => { clearTimeout(timer); ws?.close(); };
  }, []);
}
