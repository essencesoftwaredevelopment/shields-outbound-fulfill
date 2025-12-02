import { initializeApp, getApps, getApp } from "firebase/app";
import { Analytics, getAnalytics, isSupported } from "firebase/analytics";

const firebaseConfig = {
    apiKey: "AIzaSyBmzasre3tpivYewpbtpifEKDMoJFVA6Ig",
    authDomain: "shields-outbound-fulfill.firebaseapp.com",
    projectId: "shields-outbound-fulfill",
    storageBucket: "shields-outbound-fulfill.firebasestorage.app",
    messagingSenderId: "591387617784",
    appId: "1:591387617784:web:24e4efc0a38625cd82ce0d",
    measurementId: "G-HMYK8LY4Q4",
};

export const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

let analyticsInstance: Analytics | null = null;

export async function getFirebaseAnalytics() {
    if (typeof window === "undefined") {
        return null;
    }
    if (analyticsInstance) {
        return analyticsInstance;
    }
    const supported = await isSupported().catch(() => false);
    if (!supported) {
        return null;
    }
    analyticsInstance = getAnalytics(firebaseApp);
    return analyticsInstance;
}
