import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../lib/api";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function usePushNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "default"
  );
  const [isSubscribed, setIsSubscribed] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      return;
    }

    // Register service worker
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      reg.pushManager.getSubscription().then((sub) => {
        setIsSubscribed(!!sub);
      });
    }).catch((err) => {
      console.warn("ServiceWorker registration failed:", err);
    });
  }, []);

  const subscribe = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("Push notifications are not supported by your browser.");
    }

    setLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") {
        throw new Error("Notification permission was denied.");
      }

      const res = await apiFetch<{ publicKey: string }>("/push/vapid-key");
      const publicKey = res.publicKey;
      if (!publicKey) {
        throw new Error("Failed to retrieve VAPID public key.");
      }

      const reg = await navigator.serviceWorker.ready;
      const applicationServerKey = urlBase64ToUint8Array(publicKey);
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });

      await apiFetch("/push/subscribe", {
        method: "POST",
        body: JSON.stringify({ subscription }),
      });

      setIsSubscribed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.getSubscription();

      if (subscription) {
        await apiFetch("/push/unsubscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }

      setIsSubscribed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    permission,
    isSubscribed,
    loading,
    subscribe,
    unsubscribe,
    isSupported: typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window,
  };
}
