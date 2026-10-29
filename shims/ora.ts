// Browser stub for the "ora" terminal spinner, used only by the toolkit's Node logger.
// The app always passes its own logger, so this is never actually called.
type Spinner = {
  text: string;
  start: () => Spinner;
  stop: () => Spinner;
  succeed: () => Spinner;
  fail: () => Spinner;
};

const ora = (): Spinner => {
  const spinner: Spinner = {
    text: "",
    start: () => spinner,
    stop: () => spinner,
    succeed: () => spinner,
    fail: () => spinner,
  };
  return spinner;
};

export default ora;
