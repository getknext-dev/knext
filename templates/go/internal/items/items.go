// Package items is the example function's business logic: the two RPCs of
// the ExampleService contract in proto/example/v1/example.proto. Replace it
// with your own.
//
// The store is an in-memory map, so it is per pod and lost on scale-to-zero.
// A real function keeps its data in its zone's own database, read from the
// DATABASE_URL its zone binds; it never reads another zone's database.
package items

import (
	"context"
	"sync"

	"connectrpc.com/connect/v2"

	examplev1 "example.com/function/gen/example/v1"
	"example.com/function/gen/example/v1/examplev1connect"
)

// Service implements examplev1connect.ExampleServiceHandler.
type Service struct {
	mu    sync.RWMutex
	items map[string]string
}

var _ examplev1connect.ExampleServiceHandler = (*Service)(nil)

// NewService returns an empty Service.
func NewService() *Service {
	return &Service{items: map[string]string{}}
}

// GetItem reads one item. It is a read (NO_SIDE_EFFECTS), so the zone may
// retry it.
func (s *Service) GetItem(_ context.Context, req *examplev1.GetItemRequest) (*examplev1.GetItemResponse, error) {
	if req.GetId() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, "id is required")
	}
	s.mu.RLock()
	value, ok := s.items[req.GetId()]
	s.mu.RUnlock()
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, "item not found")
	}
	return &examplev1.GetItemResponse{Id: req.GetId(), Value: value}, nil
}

// PutItem writes one item. A write is never retried by the zone, and each
// call carries an `idempotency-key` header: a store that is not naturally
// idempotent records that key with the write so a resubmitted write is
// recognised and applied once.
func (s *Service) PutItem(_ context.Context, req *examplev1.PutItemRequest) (*examplev1.PutItemResponse, error) {
	if req.GetId() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, "id is required")
	}
	s.mu.Lock()
	s.items[req.GetId()] = req.GetValue()
	s.mu.Unlock()
	return &examplev1.PutItemResponse{}, nil
}
