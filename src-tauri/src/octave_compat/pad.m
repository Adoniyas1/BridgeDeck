function s = pad(s, n, side, ch)
  % BridgeDeck fill-in for MATLAB's pad (text padded with spaces, or ch, to n characters).
  if nargin < 2, n = numel(s); end
  if nargin < 3, side = 'right'; end
  if nargin < 4, ch = ' '; end
  extra = repmat(ch, 1, max(0, n - numel(s)));
  if strcmpi(side, 'left'), s = [extra s]; else, s = [s extra]; end
end
