function s = strings(varargin)
  % BridgeDeck fill-in: empty text, as a cell array of ''.
  if nargin == 0, s = ''; else, s = repmat({''}, varargin{:}); end
end
