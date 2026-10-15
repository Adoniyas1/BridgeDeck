function [counts, edges] = histcounts(x, edges)
  % BridgeDeck fill-in for MATLAB's histcounts (the last bin includes its right edge).
  x = x(:);
  if nargin < 2, edges = max(1, ceil(sqrt(numel(x)))); end
  if isscalar(edges), edges = linspace(min(x), max(x), edges + 1); end
  counts = zeros(1, numel(edges) - 1);
  for k = 1:numel(counts)
    if k < numel(counts), in = x >= edges(k) & x < edges(k+1); else, in = x >= edges(k) & x <= edges(k+1); end
    counts(k) = sum(in);
  end
end
