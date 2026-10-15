function t = tiledlayout(m, n, varargin)
  % BridgeDeck fill-in for MATLAB's tiledlayout: a grid that nexttile fills, like subplot.
  if nargin < 2, n = m; m = 1; end
  if ischar(m), m = 2; n = 2; end % 'flow': a 2-by-2 grid
  setappdata(gcf, 'bridgedeck_tiles', [m n 0]);
  t = gcf;
end
