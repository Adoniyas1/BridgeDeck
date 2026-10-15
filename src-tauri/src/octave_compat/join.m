function s = join(c, delim)
  % BridgeDeck fill-in for MATLAB's join (a cell array of text, joined with a space or delim).
  if nargin < 2, delim = ' '; end
  if ~iscell(c), c = cellstr(c); end
  s = strjoin(c(:)', delim);
end
