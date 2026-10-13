// Package pagehitcountry is a Traefik middleware (a local plugin, run by Traefik's Go interpreter) for Ghost's
// page hits (POST /.ghost/analytics/...): it fills in the visitor's country when Ghost's tracker couldn't.
//
// The tracker guesses the country from the browser's time zone and sends it as payload.location; a time zone
// with no country (UTC: privacy browsers, scrapers) leaves it null, and Ghost shows a blank country. Then, and
// only then, this sets it to Cloudflare's CF-IPCountry (worked out from the visitor's IP; "XX" unknown and
// "T1" Tor are left blank). Nothing else in the body changes, and anything it can't read passes through as it
// came. The header is only as trustworthy as the route: use it after cloudflare-only.
package pagehitcountry

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
)

// maxBody is the largest page hit it reads; a page hit is about 1 KB.
const maxBody = 64 << 10

// Config is the middleware's settings: header is where the country code comes from.
type Config struct {
	Header string `json:"header,omitempty"`
}

// CreateConfig gives the default settings.
func CreateConfig() *Config {
	return &Config{Header: "CF-IPCountry"}
}

type pageHitCountry struct {
	next   http.Handler
	header string
}

// New makes the middleware.
func New(ctx context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	h := strings.TrimSpace(config.Header)
	if h == "" {
		h = "CF-IPCountry"
	}
	return &pageHitCountry{next: next, header: h}, nil
}

func (p *pageHitCountry) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	country := strings.ToUpper(strings.TrimSpace(req.Header.Get(p.header)))
	if req.Method == http.MethodPost && req.Body != nil && isCountry(country) &&
		strings.HasPrefix(strings.ToLower(req.Header.Get("Content-Type")), "application/json") {
		body, err := io.ReadAll(io.LimitReader(req.Body, maxBody+1))
		rest := req.Body
		if err != nil || len(body) > maxBody {
			// Couldn't read it all, or too big to be a page hit: send on what was read, then the rest
			req.Body = &rejoined{r: io.MultiReader(bytes.NewReader(body), rest), c: rest}
		} else {
			_ = rest.Close()
			if out, ok := fill(body, country); ok {
				body = out
			}
			req.Body = io.NopCloser(bytes.NewReader(body))
			req.ContentLength = int64(len(body))
			req.Header.Set("Content-Length", strconv.Itoa(len(body)))
		}
	}
	p.next.ServeHTTP(rw, req)
}

// fill sets payload.location to country when it's missing, null or empty (payload being an object, or a JSON
// string holding one). ok is false when nothing changed.
func fill(body []byte, country string) ([]byte, bool) {
	var hit map[string]json.RawMessage
	if json.Unmarshal(body, &hit) != nil || hit == nil {
		return nil, false
	}
	raw, found := hit["payload"]
	if !found {
		return nil, false
	}
	var asString string
	stringified := json.Unmarshal(raw, &asString) == nil
	if stringified {
		raw = json.RawMessage(asString)
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(raw, &payload) != nil || payload == nil {
		return nil, false
	}
	var location *string
	if loc, has := payload["location"]; has && json.Unmarshal(loc, &location) != nil {
		return nil, false // not a string or null: leave it alone
	}
	if location != nil && strings.TrimSpace(*location) != "" {
		return nil, false // the time zone gave a country
	}
	loc, err := marshal(country)
	if err != nil {
		return nil, false
	}
	payload["location"] = json.RawMessage(loc)
	newPayload, err := marshal(payload)
	if err != nil {
		return nil, false
	}
	if stringified {
		quoted, err := marshal(string(newPayload))
		if err != nil {
			return nil, false
		}
		newPayload = quoted
	}
	hit["payload"] = json.RawMessage(newPayload)
	out, err := marshal(hit)
	if err != nil {
		return nil, false
	}
	return out, true
}

// marshal is json.Marshal without escaping <, > and & (so an href's & stays &).
func marshal(v interface{}) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// isCountry: two letters, not Cloudflare's "XX" (unknown) or "T1" (Tor).
func isCountry(c string) bool {
	if len(c) != 2 || c == "XX" {
		return false
	}
	for _, r := range c {
		if r < 'A' || r > 'Z' {
			return false
		}
	}
	return true
}

// rejoined is a request body put back together (explicit methods: Traefik's interpreter mixes up the
// methods of embedded interfaces).
type rejoined struct {
	r io.Reader
	c io.Closer
}

func (b *rejoined) Read(p []byte) (int, error) { return b.r.Read(p) }

func (b *rejoined) Close() error { return b.c.Close() }
