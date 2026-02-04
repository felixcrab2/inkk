import React, { useEffect, useRef, useState } from 'react';
import './App.css';

const API = process.env.REACT_APP_API_URL;

function App() {
  const menuRef     = useRef(null);
  const textRef     = useRef(null);
  const introPlayed = useRef(false);

  // 'signup' | 'login' | null
  const [mode, setMode]     = useState('signup');
  const [error, setError]   = useState(null);

  // typing intro only when mode===null
  useEffect(() => {
    if (mode !== null) return;
    // … your existing typing-animation effect here …
  }, [mode]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    const { username, password } = e.target.elements;
    const endpoint = mode === 'signup' ? '/register' : '/login';

    const res  = await fetch(API + endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        email: username.value.trim(),
        password: password.value
      })
    });
    const body = await res.json();
    if (!res.ok) setError(body.error);
    else {
      if (mode==='signup') {
        alert('Check your email for a confirmation link.');
      } else {
        setMode(null);
      }
    }
  }

  if (mode) {
    const isSignup = mode==='signup';
    return (
      <>
        <div id="menu" ref={menuRef}>inkk.</div>
        <div id="login-container">
          <form onSubmit={handleSubmit} noValidate>
            <label className="login-label">
              email:&nbsp;
              <input name="username" type="text" autoFocus />
            </label>
            <label className="login-label">
              password:&nbsp;
              <input name="password" type="password" />
            </label>
            <input type="submit" style={{display:'none'}} />
            {error && <div className="error">{error}</div>}
            <div style={{marginTop:'1rem', fontSize:'0.9rem'}}>
              {isSignup
                ? <>Have an account? <a href="#!" onClick={()=>{setError(null);setMode('login')}}>Log in</a></>
                : <>No account? <a href="#!" onClick={()=>{setError(null);setMode('signup')}}>Sign up</a></>
              }
            </div>
          </form>
        </div>
      </>
    );
  }

  return (
    <>
      <div id="menu" ref={menuRef}>inkk.</div>
      <div id="text-container">
        <div id="text" ref={textRef} tabIndex={-1}></div>
      </div>
    </>
  );
}

export default App;
