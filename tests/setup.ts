// Per-suite setup. The fixture provider is the deterministic data source for
// the whole unit run; the clock module reads MERIDIAN_CLOCK if a suite needs
// a frozen session (engine + routes suites set it themselves).

process.env.MERIDIAN_DATA_PROVIDER = 'fixture'
process.env.MERIDIAN_LOG_LEVEL = 'warn'

// Keep the platform clock honest unless a suite freezes it.
process.env.MERIDIAN_CLOCK = ''
delete process.env.MERIDIAN_CLOCK
