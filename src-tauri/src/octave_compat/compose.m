function s = compose(fmt, varargin)
  % BridgeDeck fill-in for MATLAB's compose (sprintf that keeps \n as written).
  s = sprintf(fmt, varargin{:});
end
