package stagingbar

// go test (here). Traefik's interpreter never loads a _test.go file.

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const bar = `<div id="staging">STAGING</div>`

// serve answers one request with what server does, through the middleware.
func serve(t *testing.T, server http.HandlerFunc) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	var asked *http.Request
	h, err := New(context.Background(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = r
		server(w, r)
	}), &Config{HTML: bar}, "staging-bar")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "http://staging.test/", nil)
	req.Header.Set("Accept-Encoding", "gzip, br")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec, asked
}

func page(status int, contentType, body string, header map[string]string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		for k, v := range header {
			w.Header().Set(k, v)
		}
		if status != 0 {
			w.WriteHeader(status)
		}
		_, _ = w.Write([]byte(body[:len(body)/2])) // in two writes, as a server streams it
		_, _ = w.Write([]byte(body[len(body)/2:]))
	}
}

func TestAddedBeforeHead(t *testing.T) {
	rec, asked := serve(t, page(http.StatusNotFound, "text/html; charset=utf-8",
		"<html><HEAD><title>x</title></HEAD><body>y</body></html>", map[string]string{"Content-Length": "54"}))
	if want := "<html><HEAD><title>x</title>" + bar + "</HEAD><body>y</body></html>"; rec.Body.String() != want {
		t.Errorf("got %s\nwant %s", rec.Body.String(), want)
	}
	if rec.Code != http.StatusNotFound {
		t.Errorf("status %d", rec.Code)
	}
	if rec.Header().Get("Content-Length") != "" {
		t.Error("the old Content-Length was kept")
	}
	if asked.Header.Get("Accept-Encoding") != "" {
		t.Error("the server was asked for a compressed page")
	}
}

func TestAPageWithoutHead(t *testing.T) {
	rec, _ := serve(t, page(0, "text/html", "<p>just this</p>", nil))
	if rec.Body.String() != "<p>just this</p>" || rec.Code != http.StatusOK {
		t.Errorf("%d %s", rec.Code, rec.Body.String())
	}
}

func TestEverythingElseUntouched(t *testing.T) {
	head := "<head></head>"
	for name, server := range map[string]http.HandlerFunc{
		"JSON":       page(http.StatusOK, "application/json", `{"html":"`+head+`"}`, nil),
		"compressed": page(http.StatusOK, "text/html", head, map[string]string{"Content-Encoding": "gzip"}),
		"script":     page(http.StatusOK, "text/javascript", "let h = '"+head+"'", nil),
	} {
		rec, _ := serve(t, server)
		if !strings.Contains(rec.Body.String(), head) || strings.Contains(rec.Body.String(), bar) {
			t.Errorf("%s: %s", name, rec.Body.String())
		}
	}
	rec, _ := serve(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusNotModified)
	})
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Errorf("304: %d %q", rec.Code, rec.Body.String())
	}
}

func TestEarlyHints(t *testing.T) {
	// a real server: the test recorder keeps the first status it's given, 103 included
	h, _ := New(context.Background(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Link", "</a.css>; rel=preload")
		w.WriteHeader(http.StatusEarlyHints)
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("<head></head>"))
	}), &Config{HTML: bar}, "staging-bar")
	srv := httptest.NewServer(h)
	defer srv.Close()
	res, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusCreated || string(body) != "<head>"+bar+"</head>" {
		t.Errorf("%d %s", res.StatusCode, body)
	}
}

func TestNoHTMLRefused(t *testing.T) {
	if _, err := New(context.Background(), http.NotFoundHandler(), &Config{HTML: "  "}, "x"); err == nil {
		t.Error("accepted")
	}
}
