/**
 * AuthGate component.
 *
 * Handles authentication check on startup and renders sign-in UI if needed.
 * Uses the bridge client for auth commands.
 */

import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { BridgeClient } from "../bridge_client.js";
import { loadLocalSession, saveLocalSession, type LocalSession } from "../utils/session.js";

interface AuthGateProps {
  children: React.ReactNode;
  bridgeClient: BridgeClient;
  onAuthenticated: (session: LocalSession) => void;
}

type AuthState =
  | { status: "checking" }
  | { status: "authenticated"; session: LocalSession }
  | { status: "unauthenticated" }
  | { status: "signing_in"; stateToken: string }
  | { status: "error"; message: string };

export function AuthGate({ children, bridgeClient, onAuthenticated }: AuthGateProps) {
  const { exit } = useApp();
  const [authState, setAuthState] = useState<AuthState>({ status: "checking" });
  const [pollCount, setPollCount] = useState(0);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, []);

  // Poll for auth completion when signing in
  useEffect(() => {
    if (authState.status !== "signing_in") return;

    const interval = setInterval(async () => {
      try {
        const result = await bridgeClient.rpc.call("auth.poll", { stateToken: authState.stateToken });

        if (result.success && !result.pending && result.sessionToken && result.userId && result.email) {
          const session: LocalSession = {
            sessionToken: result.sessionToken,
            userId: result.userId,
            email: result.email,
            name: result.name ?? undefined,
            createdAt: Date.now(),
          };

          saveLocalSession(session);
          setAuthState({ status: "authenticated", session });
          onAuthenticated(session);
        }
      } catch {
        // Polling error - continue waiting
      }
      setPollCount((c) => c + 1);
    }, 2000);

    return () => clearInterval(interval);
  }, [authState, bridgeClient, onAuthenticated]);

  const checkAuth = async () => {
    // Check local session first
    const session = loadLocalSession();
    if (session) {
      // Verify with daemon
      try {
        const result = await bridgeClient.rpc.call("auth.verify", { sessionToken: session.sessionToken });
        if (result.success && result.valid) {
          setAuthState({ status: "authenticated", session });
          onAuthenticated(session);
          return;
        }
      } catch {
        // Verification failed - continue to unauthenticated
      }
    }

    // Check if auth is available (try starting to see if it's configured)
    try {
      const result = await bridgeClient.rpc.call("auth.start", {});
      if (!result.success && result.error?.includes("not configured")) {
        // Auth not configured - allow unauthenticated access
        // Create a dummy session for now
        const dummySession: LocalSession = {
          sessionToken: "local",
          userId: "local",
          email: "local@localhost",
          createdAt: Date.now(),
        };
        setAuthState({ status: "authenticated", session: dummySession });
        onAuthenticated(dummySession);
        return;
      }
    } catch {
      // Connection issue - auth not available
      const dummySession: LocalSession = {
        sessionToken: "local",
        userId: "local",
        email: "local@localhost",
        createdAt: Date.now(),
      };
      setAuthState({ status: "authenticated", session: dummySession });
      onAuthenticated(dummySession);
      return;
    }

    setAuthState({ status: "unauthenticated" });
  };

  const startSignIn = async () => {
    try {
      const { hostname } = await import("os");
      const result = await bridgeClient.rpc.call("auth.start", { device: hostname() });

      if (!result.success) {
        setAuthState({ status: "error", message: result.error ?? "Failed to start sign-in" });
        return;
      }

      if (!result.authUrl || !result.stateToken) {
        setAuthState({ status: "error", message: "Invalid auth response" });
        return;
      }

      setAuthState({ status: "signing_in", stateToken: result.stateToken });

      // Open browser
      const { platform } = process;
      const { spawn } = await import("child_process");

      if (platform === "darwin") {
        spawn("open", [result.authUrl], { detached: true, stdio: "ignore" });
      } else if (platform === "win32") {
        spawn("cmd", ["/c", "start", result.authUrl], { detached: true, stdio: "ignore" });
      } else {
        spawn("xdg-open", [result.authUrl], { detached: true, stdio: "ignore" });
      }
    } catch (err) {
      setAuthState({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to start sign-in",
      });
    }
  };

  useInput((input, key) => {
    if (authState.status === "unauthenticated") {
      if (key.return) {
        startSignIn();
      } else if (input.toLowerCase() === "q") {
        exit();
      }
    } else if (authState.status === "signing_in") {
      if (key.escape) {
        setAuthState({ status: "unauthenticated" });
      }
    } else if (authState.status === "error") {
      if (key.return || key.escape) {
        exit();
      }
    }
  });

  // Render based on auth state
  if (authState.status === "checking") {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="cyan">Checking authentication...</Text>
      </Box>
    );
  }

  if (authState.status === "authenticated") {
    return <>{children}</>;
  }

  if (authState.status === "unauthenticated") {
    return (
      <Box flexDirection="column" padding={2}>
        <Box
          borderStyle="round"
          borderColor="cyan"
          flexDirection="column"
          paddingX={2}
          paddingY={1}
          width={50}
        >
          <Text color="cyan" bold>
            Welcome to Harness
          </Text>
          <Text> </Text>
          <Text>Please sign in to continue.</Text>
          <Text> </Text>
          <Text dimColor>Press Enter to open Google Sign-In</Text>
          <Text dimColor>Press Q to quit</Text>
        </Box>
      </Box>
    );
  }

  if (authState.status === "signing_in") {
    return (
      <Box flexDirection="column" padding={2}>
        <Box
          borderStyle="round"
          borderColor="yellow"
          flexDirection="column"
          paddingX={2}
          paddingY={1}
          width={60}
        >
          <Text color="yellow" bold>
            Signing In...
          </Text>
          <Text> </Text>
          <Text>A browser window should have opened.</Text>
          <Text>Complete sign-in with Google, then return here.</Text>
          <Text> </Text>
          <Text dimColor>Waiting for authentication{".".repeat((pollCount % 3) + 1)}</Text>
          <Text> </Text>
          <Text dimColor>Press Esc to cancel</Text>
        </Box>
      </Box>
    );
  }

  if (authState.status === "error") {
    return (
      <Box flexDirection="column" padding={2}>
        <Box
          borderStyle="round"
          borderColor="red"
          flexDirection="column"
          paddingX={2}
          paddingY={1}
          width={60}
        >
          <Text color="red" bold>
            Authentication Error
          </Text>
          <Text> </Text>
          <Text>{authState.message}</Text>
          <Text> </Text>
          <Text dimColor>Press Enter or Esc to exit</Text>
        </Box>
      </Box>
    );
  }

  return null;
}
