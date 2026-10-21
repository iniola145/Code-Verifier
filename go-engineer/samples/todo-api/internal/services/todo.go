package services

import (
	"context"
	"fmt"

	"example.com/todo-api/internal/repository"
)

type TodoService struct {
	repo *repository.TodoRepository
}

func NewTodoService(repo *repository.TodoRepository) *TodoService {
	return &TodoService{repo: repo}
}

func (s *TodoService) FetchTodo(ctx context.Context, id string) (*repository.Todo, error) {
	todo, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("fetch todo %s: %w", id, err)
	}
	return todo, nil
}
