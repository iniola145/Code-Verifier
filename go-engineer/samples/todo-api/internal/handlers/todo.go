package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"example.com/todo-api/internal/services"
)

type TodoHandler struct {
	svc *services.TodoService
}

func NewTodoHandler(svc *services.TodoService) *TodoHandler {
	return &TodoHandler{svc: svc}
}

func (h *TodoHandler) GetTodo(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/todos/")
	if id == "" {
		http.Error(w, "id is required", http.StatusBadRequest)
		return
	}

	todo, err := h.svc.FetchTodo(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(todo)
}
