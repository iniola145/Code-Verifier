package main

import (
	"log"
	"net/http"

	"example.com/todo-api/internal/handlers"
	"example.com/todo-api/internal/repository"
	"example.com/todo-api/internal/services"
)

func main() {
	repo := repository.NewTodoRepository(nil)
	svc := services.NewTodoService(repo)
	handler := handlers.NewTodoHandler(svc)

	mux := http.NewServeMux()
	mux.HandleFunc("/todos/", handler.GetTodo)

	log.Println("Starting Todo API on :8080...")
	if err := http.ListenAndServe(":8080", mux); err != nil {
		log.Fatalf("server failed: %v", err)
	}
}
