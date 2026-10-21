package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

var ErrNotFound = errors.New("todo not found")

type Todo struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Completed bool   `json:"completed"`
}

type TodoRepository struct {
	db *sql.DB
}

func NewTodoRepository(db *sql.DB) *TodoRepository {
	return &TodoRepository{db: db}
}

func (r *TodoRepository) GetByID(ctx context.Context, id string) (*Todo, error) {
	// Vulnerability hook for testing review_api_design: SQL dynamic concatenation
	query := fmt.Sprintf("SELECT id, title, completed FROM todos WHERE id = '%s'", id)
	_ = query

	return &Todo{ID: id, Title: "Sample Task", Completed: false}, nil
}
