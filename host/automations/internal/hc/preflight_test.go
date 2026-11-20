package hc

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeRPC(t *testing.T, result any) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "hc-rpc-probe")
	request := filepath.Join(dir, "request.json")
	raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": result})
	if err != nil {
		t.Fatal(err)
	}
	script := "#!/usr/bin/env python3\nimport json,os,sys\nrequest=json.loads(sys.stdin.readline())\nopen(os.environ['AUTOMATION_RPC_LOG'],'w').write(json.dumps(request))\nprint(os.environ['AUTOMATION_RPC_REPLY'],flush=True)\n"
	if err := os.WriteFile(bin, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HC_BIN", bin)
	t.Setenv("AUTOMATION_RPC_LOG", request)
	t.Setenv("AUTOMATION_RPC_REPLY", string(raw))
	return request
}
func TestSpaceExistsReadsExactLiveTargetCoreDocument(t *testing.T) {
	log := fakeRPC(t, map[string]any{"value": map[string]any{"spaces": []map[string]string{{"id": "sp-known"}}}, "version": 8})
	exists, err := (Client{}).SpaceExists("ivm", "sp-known")
	if err != nil || !exists {
		t.Fatalf("found=%v err=%v", exists, err)
	}
	raw, _ := os.ReadFile(log)
	var req struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	if req.Method != "doc.get" || req.Params["on"] != "ivm" || req.Params["name"] != "herdr-app" {
		t.Fatalf("wrong document target: %s", raw)
	}
	exists, err = (Client{}).SpaceExists("ivm", "sp-closed")
	if err != nil || exists {
		t.Fatalf("closed target found=%v err=%v", exists, err)
	}
}
func TestMissingDocumentDoesNotAuthorizeCreatingASpace(t *testing.T) {
	fakeRPC(t, map[string]any{"value": nil, "version": 0})
	exists, err := (Client{}).SpaceExists("", "sp-closed")
	if err != nil || exists {
		t.Fatalf("found=%v err=%v", exists, err)
	}
}
func TestLauncherResolutionUsesSelectedMachineAndExecutableCheck(t *testing.T) {
	path := "/home/me/.local/bin/herdr-agent"
	log := fakeRPC(t, map[string]any{"code": 0, "stdout": base64.StdEncoding.EncodeToString([]byte(path + "\n")), "stderr": "", "timed_out": false, "truncated": false})
	got, err := (Client{}).AgentLauncherOn("ivm")
	if err != nil || got != path {
		t.Fatalf("path=%q err=%v", got, err)
	}
	raw, _ := os.ReadFile(log)
	var req struct {
		Method string `json:"method"`
		Params struct {
			On   string   `json:"on"`
			Argv []string `json:"argv"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	if req.Method != "machine.exec" || req.Params.On != "ivm" || len(req.Params.Argv) != 3 || !strings.Contains(req.Params.Argv[2], `[ -x "$p" ]`) {
		t.Fatalf("wrong launcher preflight: %s", raw)
	}
}
func TestMissingLauncherOrMalformedPathFailsClosed(t *testing.T) {
	for _, r := range []map[string]any{{"code": 1, "stdout": ""}, {"code": 0, "stdout": base64.StdEncoding.EncodeToString([]byte("relative/path\n"))}, {"code": 0, "stdout": base64.StdEncoding.EncodeToString([]byte("/valid\ninjected\n"))}} {
		t.Run("refused", func(t *testing.T) {
			fakeRPC(t, r)
			if path, err := (Client{}).AgentLauncherOn("ivm"); err == nil {
				t.Fatalf("invalid path accepted %q", path)
			}
		})
	}
}
