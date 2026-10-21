package services_test

import (
	"context"
	"testing"

	"example.com/todo-api/internal/repository"
	"example.com/todo-api/internal/services"
)

func TestTodoService_FetchTodo(t *testing.T) {
	repo := repository.NewTodoRepository(nil)
	svc := services.NewTodoService(repo)

	todo, err := svc.FetchTodo(context.Background(), "todo-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if todo.ID != "todo-123" {
		t.Errorf("got ID %q, want todo-123", todo.ID)
	}
}
