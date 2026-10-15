function c = split(s, delim)
  % BridgeDeck fill-in for MATLAB's split: pieces as a column, split on whitespace or delim.
  if nargin < 2
    c = regexp(strtrim(s), '\s+', 'split');
  else
    c = strsplit(s, delim);
  end
  c = c(:);
end
