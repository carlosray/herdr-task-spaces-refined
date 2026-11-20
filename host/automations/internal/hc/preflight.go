package hc

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/DnzzL/herdr-automations/internal/hostpath"
)

// rpc uses the core's documented plain newline JSON-RPC transport. It does not
// depend on a running desktop window or read the core's on-disk implementation.
func rpc(result any, method string, params any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, hostpath.HCBin(), "connect")
	input, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		input.Close()
		return err
	}
	fail := func(err error) error { input.Close(); _ = cmd.Process.Kill(); _ = cmd.Wait(); return err }
	request := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
	if err = json.NewEncoder(input).Encode(request); err != nil {
		return fail(err)
	}
	var response struct {
		ID     int             `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	// App documents are limited to 1 MiB by the API. Bound malformed replies too.
	if err = json.NewDecoder(io.LimitReader(output, 2<<20)).Decode(&response); err != nil {
		return fail(fmt.Errorf("hc %s: invalid response: %w", method, err))
	}
	input.Close()
	if err = cmd.Wait(); err != nil {
		return fmt.Errorf("hc %s: connect failed: %w", method, err)
	}
	if response.ID != 1 {
		return fmt.Errorf("hc %s: mismatched reply", method)
	}
	if response.Error != nil {
		return fmt.Errorf("hc %s: %s", method, response.Error.Message)
	}
	if len(response.Result) == 0 {
		return fmt.Errorf("hc %s: missing result", method)
	}
	return json.Unmarshal(response.Result, result)
}

// SpaceExists reads the target core's current shared app document. A missing
// document or Space is false; an unreadable/disconnected core is an error.
func (Client) SpaceExists(machine, id string) (bool, error) {
	params := map[string]any{"name": "herdr-app"}
	if machine != "" {
		params["on"] = machine
	}
	var response struct {
		Value *struct {
			Spaces []struct {
				ID string `json:"id"`
			} `json:"spaces"`
		} `json:"value"`
	}
	if err := rpc(&response, "doc.get", params); err != nil {
		return false, err
	}
	if response.Value == nil {
		return false, nil
	}
	for _, s := range response.Value.Spaces {
		if s.ID == id {
			return true, nil
		}
	}
	return false, nil
}

// AgentLauncherOn resolves the user's installed adapter on the target host.
// Only this fixed script runs in a shell: no job/path/model/prompt is shell text.
func (Client) AgentLauncherOn(machine string) (string, error) {
	script := `p=$HOME/.local/bin/herdr-agent; case "$p" in /*) ;; *) exit 2;; esac; [ -f "$p" ] && [ -x "$p" ] || exit 1; printf '%s\n' "$p"`
	params := map[string]any{"argv": []string{"sh", "-c", script}, "timeout": 10}
	if machine != "" {
		params["on"] = machine
	}
	var response struct {
		Code      *int   `json:"code"`
		Stdout    []byte `json:"stdout"`
		TimedOut  bool   `json:"timed_out"`
		Truncated bool   `json:"truncated"`
	}
	if err := rpc(&response, "machine.exec", params); err != nil {
		return "", err
	}
	if response.Code == nil || *response.Code != 0 || response.TimedOut || response.Truncated {
		return "", fmt.Errorf("the target host has no executable ~/.local/bin/herdr-agent")
	}
	path := strings.TrimSuffix(string(response.Stdout), "\n")
	if !filepath.IsAbs(path) || strings.ContainsAny(path, "\x00\r\n") {
		return "", fmt.Errorf("the target host returned an invalid launcher path")
	}
	return path, nil
}
