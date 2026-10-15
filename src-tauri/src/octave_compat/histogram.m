function h = histogram(x, nbins, varargin)
  % BridgeDeck fill-in for MATLAB's histogram: bars of how many values fall in each bin.
  x = x(:);
  if nargin < 2 || ischar(nbins), nbins = max(1, ceil(sqrt(numel(x)))); end
  if isscalar(nbins)
    edges = linspace(min(x), max(x), nbins + 1);
    if edges(1) == edges(end), edges = edges(1) + (-0.5:1/nbins:0.5); end
  else
    edges = nbins;
  end
  counts = histcounts(x, edges);
  h = bar((edges(1:end-1) + edges(2:end)) / 2, counts, 1);
end
