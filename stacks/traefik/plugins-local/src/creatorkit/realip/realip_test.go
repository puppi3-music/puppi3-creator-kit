package realip

// go test (here). Traefik's interpreter never loads a _test.go file.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Cloudflare's first range (the documentation's own addresses stand in for visitors)
var cloudflare = []string{"173.245.48.0/20", " 2400:cb00::/32 "}

// serve sends one request from remote, with headers, through the middleware and gives what the server got.
func serve(t *testing.T, config *Config, remote string, headers map[string]string) http.Header {
	t.Helper()
	var got http.Header
	h, err := New(context.Background(), http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}), config, "real-ip")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "https://site.test/", nil)
	req.RemoteAddr = remote
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	h.ServeHTTP(httptest.NewRecorder(), req)
	return got
}

func want(t *testing.T, got http.Header, ip string) {
	t.Helper()
	if got.Get("X-Forwarded-For") != ip || got.Get("X-Real-Ip") != ip {
		t.Errorf("X-Forwarded-For %q, X-Real-Ip %q: want %q for both",
			got.Get("X-Forwarded-For"), got.Get("X-Real-Ip"), ip)
	}
}

func TestCloudflareIsBelieved(t *testing.T) {
	got := serve(t, &Config{TrustedIPs: cloudflare}, "173.245.48.10:443", map[string]string{
		"CF-Connecting-IP": "198.51.100.7",
		"X-Forwarded-For":  "203.0.113.1, 173.245.48.10", // what the visitor sent comes first: never believed
	})
	want(t, got, "198.51.100.7")
}

func TestAnyoneElseGetsTheirOwnAddress(t *testing.T) {
	// straight to the server, claiming to be someone else every way it can
	got := serve(t, &Config{TrustedIPs: cloudflare}, "203.0.113.9:5000", map[string]string{
		"CF-Connecting-IP": "198.51.100.7",
		"X-Forwarded-For":  "198.51.100.7",
		"X-Real-Ip":        "198.51.100.7",
		"Forwarded":        "for=198.51.100.7",
	})
	want(t, got, "203.0.113.9")
	if got.Get("Forwarded") != "" {
		t.Errorf("Forwarded left in: %q", got.Get("Forwarded"))
	}
}

func TestCloudflareWithoutTheHeader(t *testing.T) {
	want(t, serve(t, &Config{TrustedIPs: cloudflare}, "173.245.48.10:443", nil), "173.245.48.10")
	got := serve(t, &Config{TrustedIPs: cloudflare}, "173.245.48.10:443",
		map[string]string{"CF-Connecting-IP": "not an address"})
	want(t, got, "173.245.48.10")
}

func TestIPv6(t *testing.T) {
	got := serve(t, &Config{TrustedIPs: cloudflare}, "[2400:cb00::1]:443",
		map[string]string{"CF-Connecting-IP": " 2001:DB8:0:0::5 "})
	want(t, got, "2001:db8::5") // written the one way
	want(t, serve(t, &Config{TrustedIPs: cloudflare}, "[2001:db8::9]:443",
		map[string]string{"CF-Connecting-IP": "198.51.100.7"}), "2001:db8::9")
}

func TestAnotherProxysHeader(t *testing.T) {
	// a staging copy behind the main Traefik, which sets X-Real-Ip
	config := &Config{TrustedIPs: []string{"10.0.0.0/8"}, Header: " X-Real-Ip "}
	want(t, serve(t, config, "10.1.2.3:80", map[string]string{"X-Real-Ip": "198.51.100.7"}), "198.51.100.7")
	want(t, serve(t, config, "10.1.2.3:80", map[string]string{"CF-Connecting-IP": "198.51.100.7"}), "10.1.2.3")
}

func TestAnUnreadableClientAddress(t *testing.T) {
	got := serve(t, &Config{TrustedIPs: cloudflare}, "somewhere", map[string]string{
		"CF-Connecting-IP": "198.51.100.7",
		"X-Forwarded-For":  "198.51.100.7",
	})
	if got.Get("X-Forwarded-For") != "" || got.Get("X-Real-Ip") != "" {
		t.Errorf("headers kept with no address to put in them: %v", got)
	}
	// an address without a port is still read
	want(t, serve(t, &Config{TrustedIPs: cloudflare}, "203.0.113.9", nil), "203.0.113.9")
}

func TestSettingsRefused(t *testing.T) {
	for name, config := range map[string]*Config{
		"no ranges":  {},
		"bad range":  {TrustedIPs: []string{"173.245.48.0/20", "173.245.48.0"}},
		"not ranges": {TrustedIPs: []string{"cloudflare"}},
	} {
		if _, err := New(context.Background(), http.NotFoundHandler(), config, "real-ip"); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
