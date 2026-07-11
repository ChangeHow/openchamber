const isValidState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => key !== 'enabled' && key !== 'sessions')) return false;
  if (typeof value.enabled !== 'boolean' || !value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions)) return false;
  return Object.entries(value.sessions).every(([id, enabled]) => id.length > 0 && typeof enabled === 'boolean');
};

export const registerBackgroundAutoAcceptRoutes = (app, { persistSettings, getState, setState }) => {
  app.get('/api/openchamber/background-auto-accept', (_req, res) => res.json(getState()));
  app.put('/api/openchamber/background-auto-accept', async (req, res) => {
    if (!isValidState(req.body)) return res.status(400).json({ error: 'Invalid background auto-accept state' });
    const next = { enabled: req.body.enabled, sessions: { ...req.body.sessions } };
    try {
      await persistSettings({ backgroundAutoAccept: next });
      setState(next);
      return res.json(next);
    } catch (error) {
      console.error('Failed to persist background auto-accept state:', error);
      return res.status(500).json({ error: 'Failed to persist background auto-accept state' });
    }
  });
};
