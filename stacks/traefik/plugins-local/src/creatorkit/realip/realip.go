// Package realip is a Traefik middleware (a local plugin, run by Traefik's Go interpreter) that gives the
// server one trustworthy visitor address: X-Forwarded-For and X-Real-Ip are replaced with it.
//
// Cloudflare adds to the X-Forwarded-For a visitor sends instead of replacing it, and Ghost takes the leftmost
// entry, so a visitor could pick any address (and dodge Ghost's per-address sign-in and sign-up limits).
// CF-Connecting-IP is set by Cloudflare alone, so it's believed only when Cloudflare itself connected (the
// client address is in trustedIPs). Anyone else gets the address they connected from.
// Behind another proxy instead of Cloudflare (staging's Traefik, behind production's), header names the one that
// proxy sets (X-Real-Ip for Traefik) and trustedIPs are its addresses.
package realip

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
)

// Config is the middleware's settings: trustedIPs are Cloudflare's ranges (as in cloudflare-only.yml), header
// the one they set (default CF-Connecting-IP).
type Config struct {
	TrustedIPs []string `json:"trustedIPs,omitempty"`
	Header     string   `json:"header,omitempty"`
}

// CreateConfig gives the default settings.
func CreateConfig() *Config {
	return &Config{}
}

type realIP struct {
	next    http.Handler
	header  string
	trusted []*net.IPNet
}

// New makes the middleware.
func New(ctx context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	if len(config.TrustedIPs) == 0 {
		return nil, fmt.Errorf("%s: trustedIPs is empty", name)
	}
	r := &realIP{next: next, header: "CF-Connecting-IP"}
	if h := strings.TrimSpace(config.Header); h != "" {
		r.header = h
	}
	for _, s := range config.TrustedIPs {
		_, n, err := net.ParseCIDR(strings.TrimSpace(s))
		if err != nil {
			return nil, fmt.Errorf("%s: trustedIPs: %w", name, err)
		}
		r.trusted = append(r.trusted, n)
	}
	return r, nil
}

func (r *realIP) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	ip := peer(req.RemoteAddr)
	if cf := net.ParseIP(strings.TrimSpace(req.Header.Get(r.header))); cf != nil && r.fromCloudflare(ip) {
		ip = cf.String()
	}
	if ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
		req.Header.Set("X-Real-Ip", ip)
	} else {
		req.Header.Del("X-Forwarded-For")
		req.Header.Del("X-Real-Ip")
	}
	req.Header.Del("Forwarded")
	r.next.ServeHTTP(rw, req)
}

func (r *realIP) fromCloudflare(ip string) bool {
	p := net.ParseIP(ip)
	if p == nil {
		return false
	}
	for _, n := range r.trusted {
		if n.Contains(p) {
			return true
		}
	}
	return false
}

// peer is the connecting address without its port ("" if it can't be read).
func peer(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	if p := net.ParseIP(host); p != nil {
		return p.String()
	}
	return ""
}
