package main

import (
	"context"
	"encoding/json"
	"os"
	"runtime"
	"runtime/debug"
	"time"

	adcp "github.com/adcontextprotocol/adcp-go/adcp/v3"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type probe struct {
	ID       string         `json:"id"`
	Tool     string         `json:"tool"`
	Kind     string         `json:"kind"`
	Code     string         `json:"code"`
	Recovery string         `json:"recovery"`
	Request  map[string]any `json:"request"`
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func main() {
	bytes, err := os.ReadFile(os.Args[1])
	must(err)
	var plan struct {
		Cases []probe `json:"cases"`
	}
	must(json.Unmarshal(bytes, &plan))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var active probe
	called := false
	server := mcp.NewServer(&mcp.Implementation{Name: "conformance-seller", Version: "1.0.0"}, nil)
	adcp.Register(server, adcp.Config{
		IdempotencyReplayTTL: 24 * time.Hour,
		GetProducts: func(ctx context.Context, account any, request *adcp.GetProductsRequest) (*adcp.ProductsData, error) {
			called = true
			if active.Kind == "error" {
				return nil, adcp.NewError(active.Code, adcp.ErrorOptions{Message: "Conformance fixture", Recovery: active.Recovery})
			}
			return &adcp.ProductsData{Products: []adcp.Product{}, CacheScope: "public", WholesaleFeedVersion: "fixture-feed"}, nil
		},
	})
	a, b := mcp.NewInMemoryTransports()
	ss, err := server.Connect(ctx, b, nil)
	must(err)
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "conformance-buyer", Version: "1.0.0"}, nil)
	cs, err := client.Connect(ctx, a, nil)
	must(err)
	defer cs.Close()
	listing, err := cs.ListTools(ctx, nil)
	must(err)
	advertised := []string{}
	for _, tool := range listing.Tools {
		advertised = append(advertised, tool.Name)
	}
	observations := []map[string]any{}
	for _, item := range plan.Cases {
		active = item
		called = false
		present := false
		for _, name := range advertised {
			if name == item.Tool {
				present = true
			}
		}
		if !present {
			observations = append(observations, map[string]any{"id": item.ID, "skip": "Not advertised by SDK Register; no ListProducts handler in this release"})
			continue
		}
		result, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: item.Tool, Arguments: item.Request})
		row := map[string]any{"id": item.ID, "handler_called": called}
		if err != nil {
			row["transport_error"] = err.Error()
		} else {
			row["result"] = result
		}
		// Register/ProductsResponse expose no negotiated handler version. Do not
		// copy the request pin into served_version; the reporter marks it unresolved.
		observations = append(observations, row)
	}
	sdk := map[string]any{"language": "go", "package": "github.com/adcontextprotocol/adcp-go/adcp/v3", "runtime": runtime.Version()}
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range info.Deps {
			if dep.Path == sdk["package"] {
				sdk["version"] = dep.Version
				sdk["sum"] = dep.Sum
			}
			if dep.Path == "github.com/modelcontextprotocol/go-sdk" {
				sdk["mcp"] = dep.Version
			}
		}
	}
	must(json.NewEncoder(os.Stdout).Encode(map[string]any{"sdk": sdk, "transport": "MCP NewInMemoryTransports + adcp.Register/ProductsResponse/Errorf", "advertised_tools": advertised, "observations": observations}))
}
