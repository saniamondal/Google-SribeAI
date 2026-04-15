import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCHhQixfrel0cdMrNnfx1_oSlU5jVPdqKU",
  authDomain: "scribe-ai-b09ba.firebaseapp.com",
  projectId: "scribe-ai-b09ba",
  storageBucket: "scribe-ai-b09ba.firebasestorage.app",
  messagingSenderId: "69883310353",
  appId: "1:69883310353:web:2f2282213074e63e3e1cb0"
};

const app  = initializeApp(firebaseConfig);
export const auth           = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
