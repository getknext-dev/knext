package items_test

import (
	"testing"

	"connectrpc.com/connect/v2"

	examplev1 "example.com/function/gen/example/v1"
	"example.com/function/internal/items"
)

func wantCode(t *testing.T, what string, err error, code connect.Code) {
	t.Helper()
	if got := connect.CodeOf(err); err == nil || got != code {
		t.Fatalf("%s: err = %v (code %v); want code %v", what, err, got, code)
	}
}

func TestPutThenGet(t *testing.T) {
	s := items.NewService()
	if _, err := s.PutItem(t.Context(), &examplev1.PutItemRequest{Id: "a", Value: "1"}); err != nil {
		t.Fatalf("PutItem: %v", err)
	}
	res, err := s.GetItem(t.Context(), &examplev1.GetItemRequest{Id: "a"})
	if err != nil {
		t.Fatalf("GetItem: %v", err)
	}
	if res.GetId() != "a" || res.GetValue() != "1" {
		t.Fatalf("GetItem = %v; want id a, value 1", res)
	}
}

func TestPutOverwrites(t *testing.T) {
	s := items.NewService()
	for _, v := range []string{"1", "2"} {
		if _, err := s.PutItem(t.Context(), &examplev1.PutItemRequest{Id: "a", Value: v}); err != nil {
			t.Fatalf("PutItem: %v", err)
		}
	}
	res, err := s.GetItem(t.Context(), &examplev1.GetItemRequest{Id: "a"})
	if err != nil || res.GetValue() != "2" {
		t.Fatalf("GetItem = %v, %v; want value 2", res, err)
	}
}

func TestGetMissingIsNotFound(t *testing.T) {
	_, err := items.NewService().GetItem(t.Context(), &examplev1.GetItemRequest{Id: "nope"})
	wantCode(t, "GetItem of a missing id", err, connect.CodeNotFound)
}

func TestEmptyIDIsInvalidArgument(t *testing.T) {
	s := items.NewService()
	_, err := s.GetItem(t.Context(), &examplev1.GetItemRequest{})
	wantCode(t, "GetItem with no id", err, connect.CodeInvalidArgument)
	_, err = s.PutItem(t.Context(), &examplev1.PutItemRequest{Value: "x"})
	wantCode(t, "PutItem with no id", err, connect.CodeInvalidArgument)
}
