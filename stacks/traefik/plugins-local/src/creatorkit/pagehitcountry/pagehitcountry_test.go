package pagehitcountry

// go test (here). Traefik's interpreter never loads a _test.go file.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

type sent struct {
	body          string
	contentLength int64
	header        string
}

// hit sends a page hit through the middleware and gives what Ghost got.
func hit(t *testing.T, method, contentType, country, body string) sent {
	t.Helper()
	var got sent
	h, err := New(context.Background(), http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatal(err)
		}
		got = sent{string(b), r.ContentLength, r.Header.Get("Content-Length")}
	}), CreateConfig(), "page-hit-country")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, "https://site.test/.ghost/analytics/api/v0/events?name=analytics_events",
		strings.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Content-Length", strconv.Itoa(len(body)))
	if country != "" {
		req.Header.Set("CF-IPCountry", country)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return got
}

// location is payload.location in a body Ghost got (payload an object or a JSON string holding one).
func location(t *testing.T, body string) interface{} {
	t.Helper()
	var d struct{ Payload json.RawMessage }
	if err := json.Unmarshal([]byte(body), &d); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	var s string
	if json.Unmarshal(d.Payload, &s) == nil {
		d.Payload = json.RawMessage(s)
	}
	var p map[string]interface{}
	if err := json.Unmarshal(d.Payload, &p); err != nil {
		t.Fatalf("payload: %v: %s", err, body)
	}
	return p["location"]
}

const json_ = "application/json"

func TestFilledWhenTheTimeZoneGaveNone(t *testing.T) {
	for _, body := range []string{
		`{"timestamp":"2026-10-15T10:00:00Z","action":"page_hit","payload":{"location":null,"pathname":"/a/"}}`,
		`{"payload":{"pathname":"/a/"}}`,
		`{"payload":{"location":" ","pathname":"/a/"}}`,
		`{"payload":"{\"location\":null,\"pathname\":\"/a/\"}"}`, // the tracker's stringified payload
	} {
		got := hit(t, http.MethodPost, json_, "de", body)
		if location(t, got.body) != "DE" {
			t.Errorf("%s\n  -> %s", body, got.body)
		}
		if got.contentLength != int64(len(got.body)) || got.header != strconv.Itoa(len(got.body)) {
			t.Errorf("length %d / %q for a body of %d", got.contentLength, got.header, len(got.body))
		}
	}
}

func TestTheRestOfTheHitKept(t *testing.T) {
	body := `{"action":"page_hit","payload":{"location":null,"href":"https://site.test/?a=1&b=<2>","n":12.50}}`
	var before, after map[string]interface{}
	_ = json.Unmarshal([]byte(body), &before)
	got := hit(t, http.MethodPost, "application/json; charset=utf-8", "FR", body)
	if err := json.Unmarshal([]byte(got.body), &after); err != nil {
		t.Fatal(err)
	}
	before["payload"].(map[string]interface{})["location"] = "FR"
	b, _ := json.Marshal(before)
	a, _ := json.Marshal(after)
	if !bytes.Equal(a, b) {
		t.Errorf("got %s\nwant %s", a, b)
	}
	if !strings.Contains(got.body, "a=1&b=<2>") {
		t.Errorf("the link was escaped: %s", got.body)
	}
}

func TestLeftAsItCame(t *testing.T) {
	hasCountry := `{"payload":{"location":"GB","pathname":"/a/"}}`
	cases := []struct {
		name, method, contentType, country, body string
	}{
		{"a country from the time zone", http.MethodPost, json_, "DE", hasCountry},
		{"unknown country", http.MethodPost, json_, "XX", `{"payload":{"location":null}}`},
		{"Tor", http.MethodPost, json_, "T1", `{"payload":{"location":null}}`},
		{"no header", http.MethodPost, json_, "", `{"payload":{"location":null}}`},
		{"not a country code", http.MethodPost, json_, "DEU", `{"payload":{"location":null}}`},
		{"not JSON", http.MethodPost, json_, "DE", `{"payload":{"location":null`},
		{"not sent as JSON", http.MethodPost, "text/plain", "DE", `{"payload":{"location":null}}`},
		{"not a POST", http.MethodPut, json_, "DE", `{"payload":{"location":null}}`},
		{"no payload", http.MethodPost, json_, "DE", `{"location":null}`},
		{"a payload that isn't an object", http.MethodPost, json_, "DE", `{"payload":[1,2]}`},
		{"a location that isn't text", http.MethodPost, json_, "DE", `{"payload":{"location":49}}`},
		{"a list, not a hit", http.MethodPost, json_, "DE", `[{"payload":{"location":null}}]`},
	}
	for _, c := range cases {
		if got := hit(t, c.method, c.contentType, c.country, c.body); got.body != c.body {
			t.Errorf("%s: changed to %s", c.name, got.body)
		}
	}
}

func TestABigBodyPassesWhole(t *testing.T) {
	body := `{"payload":{"location":null,"pad":"` + strings.Repeat("x", maxBody) + `"}}`
	if got := hit(t, http.MethodPost, json_, "DE", body); got.body != body {
		t.Errorf("a body of %d came out as %d", len(body), len(got.body))
	}
}

func TestHeaderSetting(t *testing.T) {
	h, _ := New(context.Background(), http.NotFoundHandler(), &Config{Header: " "}, "x")
	if h.(*pageHitCountry).header != "CF-IPCountry" {
		t.Error("an empty header setting isn't the default")
	}
}
