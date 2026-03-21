package api

import "net/http"

func (h *Handler) metricsSummary(w http.ResponseWriter, r *http.Request) {
	summary, err := h.store.GetMetricsSummary(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get metrics")
		return
	}
	writeJSON(w, http.StatusOK, summary)
}
