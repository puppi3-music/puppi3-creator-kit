// Package stagingbar is a Traefik middleware (a local plugin, run by Traefik's Go interpreter) that adds a
// piece of HTML to every HTML page, just before </head>: staging's red "STAGING" bar (dynamic/staging-bar.yml),
// on Ghost's site, Ghost Admin and the bridge's pages alike, whatever they contain.
//
// It asks the server for uncompressed pages (it drops Accept-Encoding), since it can only change plain HTML.
// Anything else (JSON, images, scripts, compressed or bodyless responses) passes through untouched.
package stagingbar

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"strings"
)

// Config is the middleware's settings: html is what goes before </head>.
type Config struct {
	HTML string `json:"html,omitempty"`
}

// CreateConfig gives the default settings.
func CreateConfig() *Config {
	return &Config{}
}

type stagingBar struct {
	next http.Handler
	html []byte
}

// New makes the middleware.
func New(ctx context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	if strings.TrimSpace(config.HTML) == "" {
		return nil, fmt.Errorf("%s: html is empty", name)
	}
	return &stagingBar{next: next, html: []byte(config.HTML)}, nil
}

func (b *stagingBar) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	req.Header.Del("Accept-Encoding")
	w := &pageWriter{ResponseWriter: rw}
	b.next.ServeHTTP(w, req)
	if w.page == nil {
		return
	}
	body := w.page.Bytes()
	if i := bytes.Index(bytes.ToLower(body), []byte("</head>")); i >= 0 {
		body = append(append(append([]byte{}, body[:i]...), b.html...), body[i:]...)
	}
	rw.WriteHeader(w.status)
	_, _ = rw.Write(body)
}

// pageWriter holds back an HTML page (page != nil) until it's complete; everything else goes straight through.
type pageWriter struct {
	http.ResponseWriter
	wrote  bool
	status int
	page   *bytes.Buffer
}

func (w *pageWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	if code < 200 { // 103 Early Hints and the like: the real status is still to come
		w.ResponseWriter.WriteHeader(code)
		return
	}
	w.wrote = true
	h := w.Header()
	if code != http.StatusNoContent && code != http.StatusNotModified && h.Get("Content-Encoding") == "" &&
		strings.HasPrefix(strings.ToLower(h.Get("Content-Type")), "text/html") {
		w.status = code
		w.page = &bytes.Buffer{}
		h.Del("Content-Length") // the page gets longer
		return
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *pageWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if w.page != nil {
		return w.page.Write(p)
	}
	return w.ResponseWriter.Write(p)
}

// Flush passes flushes through for what isn't held back.
func (w *pageWriter) Flush() {
	if w.page != nil {
		return
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
