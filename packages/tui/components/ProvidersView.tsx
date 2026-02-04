/**
 * ProvidersView component.
 *
 * Displays and manages provider API keys.
 * Uses bridge client for provider operations.
 * No authentication required - stores API keys directly in config file.
 *
 * Special handling for OAuth providers (Codex):
 * - Opens browser for authentication instead of API key input
 * - Stores OAuth tokens separately from API keys
 */

import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { exec } from "child_process";
import type { BridgeClient } from "../bridge_client.js";
import { useBracketedPaste } from "../hooks/useBracketedPaste.js";
import { getAllProviders, getProviderDashboardUrl, type ProviderDefinition } from "types";
import { runCodexOAuthFlow, isCodexAuthenticated, logoutCodex } from "llm";

interface ProviderInfo {
  provider: string;
  configured: boolean;
  updatedAt?: number;
}

interface ProvidersViewProps {
  width: number;
  bridgeClient: BridgeClient;
  onClose: () => void;
}

type ViewMode =
  | { mode: "list" }
  | { mode: "add"; provider: string; input: string; cursor: number }
  | { mode: "confirm_delete"; provider: string }
  | { mode: "testing"; provider: string }
  | { mode: "oauth"; provider: string; status: "waiting" | "success" | "error"; authUrl?: string; error?: string }
  | { mode: "error"; message: string };

/** Providers that use OAuth instead of API keys */
const OAUTH_PROVIDERS = new Set(["codex"]);

// Derive provider list from central registry
const SUPPORTED_PROVIDERS = getAllProviders().map((p: ProviderDefinition) => ({
  id: p.id,
  name: p.displayName,
}));

/** Strip bracketed paste escape sequences from input */
function stripPasteMarkers(str: string): string {
  return str
    // Full escape sequences
    .replace(/\x1b\[200~/g, "")
    .replace(/\x1b\[201~/g, "")
    // Without escape char (already stripped by control char filter)
    .replace(/\[200~/g, "")
    .replace(/\[201~/g, "")
    // Catch any remaining bracket-number-tilde patterns
    .replace(/\[20[01]~/g, "");
}

export function ProvidersView({ width, bridgeClient, onClose }: ProvidersViewProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>({ mode: "list" });
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);

  // Use ref for synchronous paste state tracking (useState is async and causes race conditions)
  const isPastingRef = useRef(false);

  // Handle pasted text properly - only active in "add" mode
  useBracketedPaste({
    onPaste: (text) => {
      if (viewMode.mode === "add") {
        // Clean and store pasted text
        const clean = stripPasteMarkers(text).trim();
        setViewMode({
          ...viewMode,
          input: clean,
          cursor: clean.length,
        });
      }
    },
    onPasteStart: () => { isPastingRef.current = true; },
    onPasteEnd: () => { isPastingRef.current = false; },
    enabled: viewMode.mode === "add",
  });

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    setLoading(true);
    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersList();
      if (result.success && result.providers) {
        // Check OAuth provider status and merge
        const providerList = [...result.providers];

        // Check Codex OAuth status
        const codexAuth = await isCodexAuthenticated();
        const codexIndex = providerList.findIndex((p) => p.provider === "codex");
        if (codexIndex >= 0) {
          providerList[codexIndex] = { ...providerList[codexIndex], configured: codexAuth };
        } else if (codexAuth) {
          providerList.push({ provider: "codex", configured: true });
        }

        setProviders(providerList);
      } else {
        setMessage({
          text: result.error ?? "Failed to load providers",
          type: "error",
        });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to load providers",
        type: "error",
      });
    } finally {
      setLoading(false);
    }
  };

  const saveApiKey = async (provider: string, apiKey: string) => {
    const cleanKey = stripPasteMarkers(apiKey).trim();

    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersSave(provider, cleanKey);
      if (result.success) {
        setMessage({ text: `API key saved for ${provider}`, type: "success" });
        await loadProviders();
      } else {
        setMessage({ text: result.error ?? "Failed to save API key", type: "error" });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to save API key",
        type: "error",
      });
    }
    setViewMode({ mode: "list" });
  };

  const deleteApiKey = async (provider: string) => {
    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersDelete(provider);
      if (result.success) {
        setMessage({ text: `API key removed for ${provider}`, type: "success" });
        await loadProviders();
      } else {
        setMessage({ text: result.error ?? "Failed to remove API key", type: "error" });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to remove API key",
        type: "error",
      });
    }
    setViewMode({ mode: "list" });
  };

  const testApiKey = async (provider: string) => {
    setViewMode({ mode: "testing", provider });
    try {
      // No authentication required - local provider management
      const result = await bridgeClient.providersTest(provider);
      if (result.valid) {
        setMessage({ text: `${provider} API key is valid`, type: "success" });
      } else {
        setMessage({ text: result.error ?? `${provider} API key is invalid`, type: "error" });
      }
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to test API key",
        type: "error",
      });
    }
    setViewMode({ mode: "list" });
  };

  const startOAuthFlow = async (provider: string) => {
    if (provider === "codex") {
      setViewMode({ mode: "oauth", provider, status: "waiting" });
      try {
        await runCodexOAuthFlow({
          onAuthUrl: (url) => {
            // Update view with auth URL and open browser
            setViewMode({ mode: "oauth", provider, status: "waiting", authUrl: url });
            const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
            exec(`${cmd} "${url}"`);
          },
          onSuccess: () => {
            setViewMode({ mode: "oauth", provider, status: "success" });
            setMessage({ text: "Codex authentication successful!", type: "success" });
            // Refresh provider list to show configured status
            loadProviders();
            // Return to list after brief delay
            setTimeout(() => setViewMode({ mode: "list" }), 1500);
          },
          onError: (error) => {
            setViewMode({ mode: "oauth", provider, status: "error", error: error.message });
          },
        });
      } catch (err) {
        setViewMode({
          mode: "oauth",
          provider,
          status: "error",
          error: err instanceof Error ? err.message : "OAuth flow failed",
        });
      }
    }
  };

  const logoutOAuthProvider = async (provider: string) => {
    if (provider === "codex") {
      try {
        await logoutCodex();
        setMessage({ text: "Logged out from Codex", type: "success" });
        await loadProviders();
      } catch (err) {
        setMessage({
          text: err instanceof Error ? err.message : "Failed to logout",
          type: "error",
        });
      }
    }
    setViewMode({ mode: "list" });
  };

  useInput((input, key) => {
    // Clear message on any input
    if (message) {
      setMessage(null);
    }

    if (viewMode.mode === "list") {
      if (key.escape) {
        onClose();
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(SUPPORTED_PROVIDERS.length - 1, i + 1));
        return;
      }

      if (key.return || input === "a") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        if (OAUTH_PROVIDERS.has(provider.id)) {
          // OAuth provider - start OAuth flow
          startOAuthFlow(provider.id);
        } else {
          // API key provider - show input
          setViewMode({ mode: "add", provider: provider.id, input: "", cursor: 0 });
        }
        return;
      }

      if (input === "d") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        const providerInfo = providers.find((p) => p.provider === provider.id);
        if (providerInfo?.configured) {
          setViewMode({ mode: "confirm_delete", provider: provider.id });
        }
        return;
      }

      if (input === "t") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        const providerInfo = providers.find((p) => p.provider === provider.id);
        if (providerInfo?.configured) {
          testApiKey(provider.id);
        }
        return;
      }

      if (input === "r") {
        loadProviders();
        return;
      }

      if (input.toLowerCase() === "l") {
        const provider = SUPPORTED_PROVIDERS[selectedIndex];
        const dashboardUrl = getProviderDashboardUrl(provider.id);
        if (dashboardUrl) {
          // Open URL in default browser (cross-platform)
          const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
          exec(`${cmd} "${dashboardUrl}"`);
          setMessage({ text: `Opening ${provider.name} dashboard...`, type: "success" });
        }
        return;
      }
    } else if (viewMode.mode === "add") {
      if (key.escape) {
        setViewMode({ mode: "list" });
        return;
      }

      if (key.return) {
        if (viewMode.input.trim()) {
          saveApiKey(viewMode.provider, viewMode.input.trim());
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (viewMode.cursor > 0) {
          setViewMode({
            ...viewMode,
            input: viewMode.input.slice(0, viewMode.cursor - 1) + viewMode.input.slice(viewMode.cursor),
            cursor: viewMode.cursor - 1,
          });
        }
        return;
      }

      if (key.leftArrow) {
        setViewMode({ ...viewMode, cursor: Math.max(0, viewMode.cursor - 1) });
        return;
      }

      if (key.rightArrow) {
        setViewMode({ ...viewMode, cursor: Math.min(viewMode.input.length, viewMode.cursor + 1) });
        return;
      }

      // Regular character input (paste is handled by useBracketedPaste)
      if (input && !key.ctrl && !key.meta) {
        // Skip if pasting or if this looks like paste data
        if (isPastingRef.current || input.includes("[200~") || input.includes("[201~")) {
          return;
        }
        // Filter control characters and strip any paste markers that slipped through
        // Preserve whitespace: tab (\x09), newline (\x0a), carriage return (\x0d)
        const clean = stripPasteMarkers(input.replace(/[\x00-\x08\x0b\x0e-\x1f\x7f]/g, ""));
        if (clean) {
          setViewMode({
            ...viewMode,
            input: viewMode.input.slice(0, viewMode.cursor) + clean + viewMode.input.slice(viewMode.cursor),
            cursor: viewMode.cursor + clean.length,
          });
        }
      }
    } else if (viewMode.mode === "confirm_delete") {
      if (key.escape || input.toLowerCase() === "n") {
        setViewMode({ mode: "list" });
        return;
      }

      if (input.toLowerCase() === "y") {
        if (OAUTH_PROVIDERS.has(viewMode.provider)) {
          logoutOAuthProvider(viewMode.provider);
        } else {
          deleteApiKey(viewMode.provider);
        }
        return;
      }
    } else if (viewMode.mode === "oauth") {
      // In OAuth mode, Esc returns to list (OAuth flow continues in background but will be ignored)
      if (key.escape) {
        setViewMode({ mode: "list" });
        return;
      }
      // Enter returns to list after success/error
      if (key.return && (viewMode.status === "success" || viewMode.status === "error")) {
        setViewMode({ mode: "list" });
        return;
      }
    } else if (viewMode.mode === "error") {
      if (key.escape || key.return) {
        onClose();
      }
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan">Loading providers...</Text>
      </Box>
    );
  }

  if (viewMode.mode === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{viewMode.message}</Text>
        <Text dimColor>Press Esc to close</Text>
      </Box>
    );
  }

  if (viewMode.mode === "oauth") {
    const providerName = SUPPORTED_PROVIDERS.find((p) => p.id === viewMode.provider)?.name ?? viewMode.provider;

    if (viewMode.status === "waiting") {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="cyan" bold>
            Login to {providerName}
          </Text>
          <Text> </Text>
          {viewMode.authUrl ? (
            <>
              <Text color="yellow">Opening browser for authentication...</Text>
              <Text> </Text>
              <Text dimColor>If the browser didn't open, visit:</Text>
              <Text color="blue">{viewMode.authUrl}</Text>
              <Text> </Text>
              <Text dimColor>Waiting for authentication...</Text>
            </>
          ) : (
            <Text color="yellow">Starting authentication flow...</Text>
          )}
          <Text> </Text>
          <Text dimColor>[Esc] Cancel</Text>
        </Box>
      );
    }

    if (viewMode.status === "success") {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="green" bold>
            Authentication Successful!
          </Text>
          <Text> </Text>
          <Text>You are now logged in to {providerName}.</Text>
          <Text> </Text>
          <Text dimColor>[Enter] Continue</Text>
        </Box>
      );
    }

    if (viewMode.status === "error") {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>
            Authentication Failed
          </Text>
          <Text> </Text>
          <Text color="red">{viewMode.error ?? "Unknown error"}</Text>
          <Text> </Text>
          <Text dimColor>[Enter/Esc] Back to list</Text>
        </Box>
      );
    }
  }

  if (viewMode.mode === "add") {
    const providerName = SUPPORTED_PROVIDERS.find((p) => p.id === viewMode.provider)?.name ?? viewMode.provider;

    return (
      <Box flexDirection="column" padding={1}>
        <Text color="cyan" bold>
          Set API key for {providerName}
        </Text>
        <Text> </Text>
        <Box>
          <Text color="cyan">▸ </Text>
          <Text>{stripPasteMarkers(viewMode.input)}</Text>
          <Text backgroundColor="cyan"> </Text>
        </Box>
        <Text> </Text>
        <Text dimColor>[Enter] Save  [Esc] Back to list</Text>
      </Box>
    );
  }

  if (viewMode.mode === "confirm_delete") {
    const providerName = SUPPORTED_PROVIDERS.find((p) => p.id === viewMode.provider)?.name ?? viewMode.provider;
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red" bold>
          Remove API key for {providerName}?
        </Text>
        <Text> </Text>
        <Text dimColor>[Y] Yes  [N/Esc] Back to list</Text>
      </Box>
    );
  }

  if (viewMode.mode === "testing") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="yellow">Testing {viewMode.provider} API key...</Text>
      </Box>
    );
  }

  // List view
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        Provider Configuration
      </Text>
      <Text>{"─".repeat(Math.min(40, width - 4))}</Text>
      <Text> </Text>

      {SUPPORTED_PROVIDERS.map((provider, index) => {
        const info = providers.find((p) => p.provider === provider.id);
        const configured = info?.configured ?? false;
        const isSelected = index === selectedIndex;
        const prefix = isSelected ? "> " : "  ";
        const status = configured ? "✓" : "○";
        const statusColor = configured ? "green" : "gray";
        const dashboardUrl = getProviderDashboardUrl(provider.id);

        return (
          <Box key={provider.id} flexDirection="column">
            <Text>
              {prefix}
              <Text color={statusColor}>{status}</Text>
              {" "}
              <Text color={isSelected ? "cyan" : undefined}>{provider.name}</Text>
            </Text>
            {isSelected && dashboardUrl && (
              <Text dimColor>    ↳ <Text color="blue">{dashboardUrl}</Text> Hold [L]</Text>
            )}
          </Box>
        );
      })}

      <Text> </Text>
      <Text>{"─".repeat(Math.min(40, width - 4))}</Text>

      {message && (
        <>
          <Text color={message.type === "success" ? "green" : "red"}>{message.text}</Text>
          <Text> </Text>
        </>
      )}

      <Text dimColor>
        [Enter/A] Add  [D] Delete  [T] Test  Hold [L] Dashboard  [R] Refresh  [Esc] Close
      </Text>
    </Box>
  );
}
